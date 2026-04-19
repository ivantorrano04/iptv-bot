/**
 * Lightweight M3U8 token extractor — HTTP only, no browser needed.
 * 
 * The player page embeds the token as base64 URL-safe fragments inside
 * an eval-packed script. We fetch the HTML, unpack the script, decode
 * the fragments, and reconstruct the m3u8 URL.
 */

const delay = ms => new Promise(r => setTimeout(r, ms));

function b64decode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf-8');
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Fetch the player page HTML and extract the m3u8 URL with token.
 */
async function extractToken(channelName, channelCode) {
  const playerUrl = `https://cdnlivetv.tv/api/v1/channels/player/?name=${encodeURIComponent(channelName)}&code=${channelCode}&user=cdnlivetv&plan=free`;
  console.log(`[extract] ${channelName} (${channelCode})`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(playerUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
        }
      });

      if (!resp.ok) {
        console.log(`[extract] HTTP ${resp.status}`);
        if (attempt < 3) { await delay(1000); continue; }
        return { success: false, error: `HTTP ${resp.status}` };
      }

      const html = await resp.text();
      if (html.length < 200) {
        console.log(`[extract] Empty page (${html.length} bytes), retry ${attempt}/3`);
        if (attempt < 3) { await delay(1500); continue; }
        return { success: false, error: 'Empty page' };
      }

      // Strategy 1: Unpack eval-packed script and extract base64 fragments
      const url = extractFromEvalPacker(html);
      if (url) {
        console.log(`[extract] OK via eval-unpack (attempt ${attempt})`);
        return { success: true, m3u8Url: url, method: `unpack-${attempt}` };
      }

      // Strategy 2: Find base64 fragments directly in raw HTML
      const url2 = extractFromRawBase64(html);
      if (url2) {
        console.log(`[extract] OK via raw-b64 (attempt ${attempt})`);
        return { success: true, m3u8Url: url2, method: `raw-b64-${attempt}` };
      }

      // Strategy 3: Direct URL match in HTML
      const url3 = extractDirectUrl(html);
      if (url3) {
        console.log(`[extract] OK via direct-url (attempt ${attempt})`);
        return { success: true, m3u8Url: url3, method: `direct-${attempt}` };
      }

      console.log(`[extract] No token found, attempt ${attempt}/3`);
      if (attempt < 3) await delay(1500 + Math.random() * 1000);

    } catch (err) {
      console.log(`[extract] Error attempt ${attempt}: ${err.message}`);
      if (attempt < 3) await delay(1500);
    }
  }

  return { success: false, error: 'No se pudo extraer el token del canal.' };
}

/**
 * Strategy 1: Find eval(function(h,u,n,t,e,r){...}) packer, unpack it,
 * then parse the decoded JS to reconstruct the m3u8 URL from base64 fragments.
 */
function extractFromEvalPacker(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const [, code] of scripts) {
    if (code.length < 500) continue;
    const evalIdx = code.indexOf('eval(');
    if (evalIdx === -1) continue;

    try {
      const beforeEval = code.substring(0, evalIdx);
      const afterEval = code.substring(evalIdx);
      // Replace eval() with return () to get the decoded string instead of executing it
      const decoded = new Function(beforeEval + 'return ' + afterEval.replace('eval(', '('))();

      if (!decoded || typeof decoded !== 'string') continue;

      // Find the base64 decode function name (e.g. ymCaHuiWaVKN)
      const funcMatch = decoded.match(/function\s+(\w+)\(str\)\s*\{[^}]*str\.replace\(\/-\/g/);
      if (!funcMatch) continue;
      const funcName = funcMatch[1];

      // Extract all string constants: const VAR = 'base64value';
      const constMap = {};
      const constRegex = /const\s+(\w+)\s*=\s*'([^']+)'/g;
      let m;
      while ((m = constRegex.exec(decoded)) !== null) {
        constMap[m[1]] = m[2];
      }

      // Find concatenation expressions: funcName(A) + funcName(B) + ...
      const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const concatRegex = new RegExp(
        `const\\s+\\w+\\s*=\\s*((?:${escapedName}\\(\\w+\\)\\s*\\+\\s*)*${escapedName}\\(\\w+\\)\\s*)`,
        'g'
      );

      let found = null;
      while ((m = concatRegex.exec(decoded)) !== null) {
        const expr = m[1];
        const varRefs = [...expr.matchAll(new RegExp(`${escapedName}\\((\\w+)\\)`, 'g'))];
        let url = '';
        for (const ref of varRefs) {
          const b64 = constMap[ref[1]];
          if (b64) url += b64decode(b64);
        }
        if (url.includes('playlist.m3u8') && url.includes('token=')) {
          found = url;
        }
      }
      if (found) return found;
    } catch (e) {
      // Unpack failed, try next script
    }
  }
  return null;
}

/**
 * Strategy 2: Scan all inline scripts for base64 strings that decode to
 * m3u8 URL fragments and reconstruct the URL.
 */
function extractFromRawBase64(html) {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const [, code] of scripts) {
    if (code.length < 500) continue;

    // Find all quoted strings that could be base64
    const b64Strings = [...code.matchAll(/['"]([A-Za-z0-9_-]{4,})['"]/g)];
    if (b64Strings.length < 5) continue;

    const fragments = [];
    for (const [, raw] of b64Strings) {
      try {
        const d = b64decode(raw);
        if (d.includes('edge.') || d.includes('playlist.m3u8') ||
            d.includes('token=') || d.includes('signature=') ||
            d.includes('/secure/') || d.includes('cdnlivetv')) {
          fragments.push(d);
        }
      } catch { /* not valid b64 */ }
    }

    if (fragments.length > 0) {
      // Try joining all fragments
      const full = fragments.join('');
      if (full.includes('playlist.m3u8') && full.includes('token=')) {
        // Extract just the URL from the joined string
        const match = full.match(/(https?:\/\/[^\s]+playlist\.m3u8\?token=[^\s]+)/);
        if (match) return match[1];
        return full;
      }
      // Try each individually
      for (const f of fragments) {
        if (f.includes('playlist.m3u8') && f.includes('token=')) return f;
      }
    }
  }
  return null;
}

/**
 * Strategy 3: Direct regex match for m3u8 URL in HTML.
 */
function extractDirectUrl(html) {
  const match = html.match(/(https?:\/\/edge[^\s"'<>]+playlist\.m3u8\?token=[^\s"'<>]+)/);
  return match ? match[1] : null;
}

// No-op for backward compatibility with server.js
function closeBrowser() {}

module.exports = { extractToken, closeBrowser };
