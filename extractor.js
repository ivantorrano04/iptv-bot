const puppeteer = require('puppeteer');

let browser = null;
const delay = ms => new Promise(r => setTimeout(r, ms));

async function getBrowser() {
  if (!browser || !browser.connected) {
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--single-process',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--no-first-run',
        '--no-zygote',
        '--js-flags=--max-old-space-size=256'
      ]
    };
    // Use system Chromium on cloud (Render/Docker)
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    browser = await puppeteer.launch(launchOptions);
  }
  return browser;
}

/**
 * Check if page loaded actual content or is empty
 */
async function isPageEmpty(page) {
  try {
    const result = await page.evaluate(() => ({
      bodyLen: (document.body && document.body.innerHTML.length) || 0,
      title: document.title
    }));
    return result.bodyLen === 0;
  } catch { return true; }
}

/**
 * Create a fresh page in a new incognito context (clean cookies/session)
 */
async function createFreshPage(b) {
  const context = await b.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  );
  // Add extra headers to look more like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  });
  return { page, context };
}

/**
 * Strategy 1: Extract m3u8 URL directly from the page's inline JS.
 * The token is embedded as base64 URL-safe fragments in the obfuscated script.
 */
async function extractFromPageSource(page) {
  try {
    const m3u8Url = await page.evaluate(() => {
      // Base64 URL-safe decoder (same as ymCaHuiWaVKN in their code)
      function b64decode(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        try { return decodeURIComponent(escape(atob(str))); }
        catch (e) { return atob(str); }
      }

      // Get all inline scripts
      const scripts = [...document.querySelectorAll('script')];
      for (const script of scripts) {
        const code = script.textContent || '';
        // Skip empty or external scripts
        if (code.length < 100) continue;

        // Look for the eval(function(h,u,n,t,e,r) packer pattern
        const packerMatch = code.match(/eval\(function\(h,u,n,t,e,r\)\{.*?\}\("([^"]+)"/s);
        if (packerMatch) {
          // Unpack the p.a.c.k.e.r code
          try {
            const unpacked = new Function('return ' + code.replace(/^eval/, ''))();
            if (unpacked && unpacked.includes('playlist.m3u8')) {
              const urlMatch = unpacked.match(/(https?:\/\/[^\s"']+playlist\.m3u8[^\s"']+)/);
              if (urlMatch) return urlMatch[1];
            }
          } catch (e) { /* ignore unpack errors */ }
        }

        // Look for base64 strings that decode to m3u8 URL parts
        // Pattern: multiple b64 strings concatenated to form the URL
        const b64Strings = code.match(/["']([A-Za-z0-9_-]{4,})["']/g);
        if (!b64Strings) continue;

        const decoded = [];
        for (const match of b64Strings) {
          const raw = match.slice(1, -1);
          try {
            const d = b64decode(raw);
            if (d.includes('edge.') || d.includes('playlist.m3u8') || 
                d.includes('token=') || d.includes('signature=') ||
                d.includes('/secure/') || d.includes('cdnlivetv')) {
              decoded.push({ raw, decoded: d });
            }
          } catch (e) { /* not valid b64 */ }
        }

        // If we found URL fragments, try to reconstruct
        if (decoded.length > 0) {
          // Try to find the full URL by joining decoded parts
          const all = decoded.map(d => d.decoded);
          const fullUrl = all.join('');
          if (fullUrl.includes('playlist.m3u8') && fullUrl.includes('token=')) {
            return fullUrl;
          }
          // Try each individually
          for (const d of decoded) {
            if (d.decoded.includes('playlist.m3u8') && d.decoded.includes('token=')) {
              return d.decoded;
            }
          }
        }
      }

      // Alternative: look for the URL in any JS variable or property
      // The player page sometimes has the URL in a constructed string
      const allText = document.documentElement.innerHTML;
      const urlMatch = allText.match(/(https?:\/\/edge[^\s"'<>]+playlist\.m3u8\?token=[^\s"'<>]+)/);
      if (urlMatch) return urlMatch[1];

      return null;
    });
    return m3u8Url;
  } catch (e) {
    console.log(`[extractFromPageSource] Error: ${e.message}`);
    return null;
  }
}

/**
 * Strategy 2: Click the dynamic "Refresh Page" button.
 * The button is created dynamically inside #loading div with onclick that either
 * calls location.reload() or a function like VPNaORdexzZbAXan().
 */
async function clickRefreshButton(page) {
  try {
    const result = await page.evaluate(() => {
      // The button is inside #loading div, has onclick attribute
      const buttons = document.querySelectorAll('#loading button, button[onclick]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('refresh') || text.includes('reload') || text.includes('retry')) {
          // Check what the onclick does
          const onclick = btn.getAttribute('onclick') || '';
          return { found: true, text: btn.textContent.trim(), onclick };
        }
      }
      // Also search all buttons by text
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('refresh') || text.includes('reload') || text.includes('retry')) {
          const onclick = btn.getAttribute('onclick') || '';
          return { found: true, text: btn.textContent.trim(), onclick };
        }
      }
      return { found: false };
    });

    if (!result.found) {
      console.log('[clickRefresh] No refresh button found in DOM');
      return false;
    }

    console.log(`[clickRefresh] Found button: "${result.text}" onclick="${result.onclick}"`);

    // If onclick is location.reload(), we handle it differently
    if (result.onclick.includes('location.reload')) {
      // Instead of reloading (which loses our interception), execute inline
      console.log('[clickRefresh] Button does location.reload - reloading page');
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });
      return true;
    }

    // Otherwise click the button (it calls something like VPNaORdexzZbAXan())
    await page.evaluate(() => {
      const buttons = document.querySelectorAll('#loading button, button[onclick]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('refresh') || text.includes('reload') || text.includes('retry')) {
          btn.click();
          return;
        }
      }
      // fallback
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('refresh') || text.includes('reload') || text.includes('retry')) {
          btn.click();
          return;
        }
      }
    });
    return true;
  } catch (e) {
    console.log(`[clickRefresh] Error: ${e.message}`);
    return false;
  }
}

async function extractToken(channelName, channelCode) {
  const playerUrl = `https://cdnlivetv.tv/api/v1/channels/player/?name=${encodeURIComponent(channelName)}&code=${channelCode}&user=cdnlivetv&plan=free`;
  console.log(`[extractToken] Opening: ${playerUrl}`);

  const b = await getBrowser();
  const MAX_RETRIES = process.env.PUPPETEER_EXECUTABLE_PATH ? 2 : 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[extractToken] --- Round ${attempt}/${MAX_RETRIES} ---`);

    // Each attempt uses a fresh incognito context (clean cookies/cache)
    const { page, context } = await createFreshPage(b);
    let m3u8Url = null;

    // Set up network interception
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('playlist.m3u8') && url.includes('token=')) {
        m3u8Url = url;
        console.log(`[extractToken] Captured M3U8: ${url.substring(0, 120)}...`);
      }
      req.continue();
    });
    page.on('response', (res) => {
      const url = res.url();
      if (url.includes('playlist.m3u8') && url.includes('token=')) {
        m3u8Url = url;
      }
    });

    try {
      // Step 1: Load page
      const urlToLoad = attempt === 1
        ? playerUrl
        : playerUrl + '&first=0';  // subsequent attempts simulate revisit

      await page.goto(urlToLoad, { waitUntil: 'networkidle2', timeout: 25000 });

      // Check if we got the token during load
      if (m3u8Url) {
        console.log(`[extractToken] SUCCESS (round ${attempt}) via network intercept`);
        await context.close();
        await maybeCloseBrowser();
        return { success: true, m3u8Url, method: `network-r${attempt}` };
      }

      // Check if page is empty — if so, skip to next round
      if (await isPageEmpty(page)) {
        console.log(`[extractToken] Round ${attempt}: page is EMPTY, retrying with fresh context...`);
        await context.close();
        await delay(1000 + Math.random() * 1000); // random delay before retry
        continue;
      }

      // Step 2: Try extracting from page source
      await delay(800);
      const sourceUrl = await extractFromPageSource(page);
      if (sourceUrl) {
        console.log(`[extractToken] SUCCESS (round ${attempt}) via page source`);
        await context.close();
        await maybeCloseBrowser();
        return { success: true, m3u8Url: sourceUrl, method: `source-r${attempt}` };
      }

      // Step 3: Try clicking Refresh button
      await delay(1000);
      const clicked = await clickRefreshButton(page);
      if (clicked) {
        console.log(`[extractToken] Round ${attempt}: refresh clicked, waiting...`);
        const maxWait = 12000;
        const start = Date.now();
        while (!m3u8Url && (Date.now() - start) < maxWait) {
          await delay(500);
        }

        if (m3u8Url) {
          console.log(`[extractToken] SUCCESS (round ${attempt}) via refresh click`);
          await context.close();
          await maybeCloseBrowser();
          return { success: true, m3u8Url, method: `refresh-r${attempt}` };
        }

        // Try source after refresh
        const sourceUrl2 = await extractFromPageSource(page);
        if (sourceUrl2) {
          console.log(`[extractToken] SUCCESS (round ${attempt}) via source after refresh`);
          await context.close();
          await maybeCloseBrowser();
          return { success: true, m3u8Url: sourceUrl2, method: `source-post-refresh-r${attempt}` };
        }
      }

      // Step 4: Reload and try once more in same context
      console.log(`[extractToken] Round ${attempt}: reloading...`);
      await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });

      if (m3u8Url) {
        console.log(`[extractToken] SUCCESS (round ${attempt}) via reload`);
        await context.close();
        await maybeCloseBrowser();
        return { success: true, m3u8Url, method: `reload-r${attempt}` };
      }

      await delay(800);
      const sourceUrl3 = await extractFromPageSource(page);
      if (sourceUrl3) {
        console.log(`[extractToken] SUCCESS (round ${attempt}) via source after reload`);
        await context.close();
        await maybeCloseBrowser();
        return { success: true, m3u8Url: sourceUrl3, method: `source-post-reload-r${attempt}` };
      }

      // This round failed, close and try next round with fresh context
      await context.close();
      if (attempt < MAX_RETRIES) {
        console.log(`[extractToken] Round ${attempt} failed, retrying with fresh context...`);
        await delay(1500 + Math.random() * 1000);
      }

    } catch (err) {
      console.log(`[extractToken] Round ${attempt} error: ${err.message}`);
      try { await context.close(); } catch (_) {}
      if (attempt < MAX_RETRIES) {
        await delay(1500 + Math.random() * 1000);
      }
    }
  }

  // All rounds exhausted — kill browser to free memory
  console.log('[extractToken] ALL ROUNDS FAILED — closing browser to free memory');
  await closeBrowser();
  return {
    success: false,
    error: 'No se pudo capturar el token. El canal puede estar offline o bloqueado.'
  };
}

// Close browser after each successful extraction on cloud to save memory
async function maybeCloseBrowser() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    // Cloud environment — close browser after each extraction
    await closeBrowser();
  }
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch(_) {}
    browser = null;
  }
}

module.exports = { extractToken, closeBrowser };
