const express = require('express');
const cors = require('cors');
const path = require('path');
const { extractToken, closeBrowser } = require('./extractor');

const app = express();
app.use(cors());
app.use(express.json());

// Serve dashboard
app.use(express.static(path.join(__dirname)));

// === Proxy channels API to avoid CORS issues ===
app.get('/api/channels', async (req, res) => {
  try {
    const response = await fetch(`https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('[API] Channels proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch channels from upstream API' });
  }
});

// === Extract M3U8 token for a channel ===
app.post('/api/extract', async (req, res) => {
  const { name, code } = req.body;
  if (!name || !code) {
    return res.status(400).json({ error: 'Missing "name" or "code" in body' });
  }

  console.log(`\n[API] Extract request: name="${name}", code="${code}"`);
  const start = Date.now();

  try {
    const result = await extractToken(name, code);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[API] Result (${elapsed}s): ${result.success ? 'OK' : 'FAIL'}`);

    if (result.success) {
      res.json({
        success: true,
        m3u8Url: result.m3u8Url,
        proxyUrl: `/stream?url=${result.m3u8Url}`,
        method: result.method,
        elapsed: `${elapsed}s`
      });
    } else {
      res.json({ success: false, error: result.error, debug: result.debug || null, elapsed: `${elapsed}s` });
    }
  } catch (err) {
    console.error('[API] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Batch extract multiple channels ===
app.post('/api/extract-batch', async (req, res) => {
  const { channels } = req.body;
  if (!Array.isArray(channels) || channels.length === 0) {
    return res.status(400).json({ error: 'Missing "channels" array in body' });
  }

  // Limit to 5 at a time to avoid overloading
  const batch = channels.slice(0, 5);
  console.log(`\n[API] Batch extract: ${batch.length} channels`);

  const results = [];
  for (const ch of batch) {
    try {
      const result = await extractToken(ch.name, ch.code);
      results.push({
        name: ch.name,
        code: ch.code,
        ...result,
        proxyUrl: result.success
          ? `/stream?url=${result.m3u8Url}`
          : null
      });
    } catch (err) {
      results.push({ name: ch.name, code: ch.code, success: false, error: err.message });
    }
  }

  res.json({ results });
});

// === IPTV Player endpoint — M3UIPTV/Kodi calls this URL ===
// Proxies HLS directly (no redirect) — extracts token on demand per channel switch
const tokenCache = new Map();
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

async function getTokenForChannel(code, name) {
  const cacheKey = `${code}:${name}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < CACHE_TTL) {
    return { m3u8Url: cached.m3u8Url, fromCache: true };
  }
  const result = await extractToken(name, code);
  if (result.success) {
    tokenCache.set(cacheKey, { m3u8Url: result.m3u8Url, time: Date.now() });
    return { m3u8Url: result.m3u8Url, fromCache: false, method: result.method };
  }
  return { error: result.error };
}

function buildProxyBase(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/stream?url=`;
}

function rewriteM3u8(body, upstreamUrl, proxyBase) {
  const baseUrl = upstreamUrl.substring(0, upstreamUrl.lastIndexOf('/') + 1);
  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t) return line;
    // Rewrite URI= attributes in #EXT tags
    if (t.startsWith('#')) {
      if (t.includes('URI="')) {
        return t.replace(/URI="([^"]+)"/g, (_, uri) => {
          if (uri.startsWith('http')) return `URI="${proxyBase}${uri}"`;
          return `URI="${proxyBase}${baseUrl}${uri}"`;
        });
      }
      return line;
    }
    // URL line
    if (t.startsWith('http')) return `${proxyBase}${t}`;
    return `${proxyBase}${baseUrl}${t}`;
  }).join('\n');
}

const UPSTREAM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://cdnlivetv.tv/',
  'Accept': '*/*',
  'Connection': 'keep-alive'
};

app.get('/play/:code/:name', async (req, res) => {
  const { code, name } = req.params;
  console.log(`\n[PLAY] ${name} (${code})`);

  try {
    let token = await getTokenForChannel(code, name);
    if (token.error) {
      console.log(`[PLAY] FAIL: ${token.error}`);
      return res.status(503).type('text/plain').send(`# Error: ${token.error}`);
    }
    console.log(`[PLAY] Token ${token.fromCache ? 'from cache' : 'extracted (' + token.method + ')'}`);

    // Fetch upstream m3u8
    let upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });

    // If 403/401, token expired — extract fresh
    if (upstream.status === 403 || upstream.status === 401) {
      console.log(`[PLAY] Token expired (${upstream.status}), re-extracting...`);
      tokenCache.delete(`${code}:${name}`);
      token = await getTokenForChannel(code, name);
      if (token.error) return res.status(503).type('text/plain').send(`# Error: ${token.error}`);
      upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).type('text/plain').send(`# Upstream error ${upstream.status}`);
    }

    // Rewrite m3u8 URLs to go through our proxy
    const body = await upstream.text();
    const proxyBase = buildProxyBase(req);
    const rewritten = rewriteM3u8(body, token.m3u8Url, proxyBase);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(rewritten);
  } catch (err) {
    console.error(`[PLAY] Error: ${err.message}`);
    if (!res.headersSent) res.status(500).type('text/plain').send(`# Error: ${err.message}`);
  }
});

// === Generate M3U8 playlist pointing to this server ===
const fs = require('fs');

app.get('/playlist.m3u8', (req, res) => {
  const host = req.query.host || req.headers.host || 'localhost:3000';
  const protocol = req.query.protocol || 'http';
  const canalFile = path.join(__dirname, 'canales.txt');

  if (!fs.existsSync(canalFile)) {
    return res.status(404).send('#EXTM3U\n# canales.txt not found');
  }

  const lines = fs.readFileSync(canalFile, 'utf-8').split('\n');
  let m3u = '#EXTM3U\n';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(',');
    const name = parts[0].trim();
    const code = parts[1] ? parts[1].trim() : 'es';
    const group = parts[2] ? parts[2].trim() : 'General';

    const encodedName = encodeURIComponent(name);
    m3u += `#EXTINF:-1 group-title="${group}",${name}\n`;
    m3u += `${protocol}://${host}/play/${code}/${encodedName}\n`;
  }

  res.set('Content-Type', 'application/x-mpegURL');
  res.send(m3u);
});

// === Stream proxy (with smart m3u8 URL rewriting) ===
app.get('/stream', async (req, res) => {
  // Get the full URL after ?url= (preserving & in the token)
  const urlParam = req.url.split('url=')[1];
  if (!urlParam) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const upstream = await fetch(urlParam, { headers: UPSTREAM_HEADERS });

    if (!upstream.ok) {
      console.log(`[STREAM] Upstream error: ${upstream.status}`);
      return res.status(upstream.status).send(`Upstream error ${upstream.status}`);
    }

    const ct = upstream.headers.get('content-type') || '';
    const isM3u8 = ct.includes('mpegurl') || ct.includes('m3u8') || urlParam.includes('.m3u8');

    if (isM3u8) {
      // Rewrite URLs inside m3u8 playlists (variant playlists, segment lists)
      const body = await upstream.text();
      const proxyBase = buildProxyBase(req);
      const rewritten = rewriteM3u8(body, urlParam, proxyBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Access-Control-Allow-Origin', '*');
      res.send(rewritten);
    } else {
      // Binary content (ts segments, etc.) — pipe through
      if (ct) res.set('Content-Type', ct);
      res.set('Access-Control-Allow-Origin', '*');

      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.writableEnded) res.write(Buffer.from(value));
        }
        if (!res.writableEnded) res.end();
      };
      pump().catch(() => { try { res.end(); } catch(_) {} });
      req.on('close', () => { try { reader.cancel(); } catch(_) {} });
    }
  } catch (err) {
    console.error(`[STREAM] Error: ${err.message}`);
    if (!res.headersSent) res.status(500).send('Stream proxy error');
  }
});

// === Health check (used by keep-alive and monitoring) ===
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cache: tokenCache.size });
});

// === Auto-refresh: cron every 3 hours + Gist update on startup ===
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID || '8028547c786162756e9f5b9ced06c3df';

function readCanales() {
  const file = path.join(__dirname, 'canales.txt');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'))
    .map(l => {
      const parts = l.split(',');
      return { name: parts[0].trim(), code: (parts[1] || 'es').trim(), group: (parts[2] || 'General').trim() };
    });
}

function buildM3u8(canales, host) {
  let m3u = '#EXTM3U\n';
  for (const ch of canales) {
    m3u += `#EXTINF:-1 group-title="${ch.group}",${ch.name}\n`;
    m3u += `${host}/play/${ch.code}/${encodeURIComponent(ch.name)}\n`;
  }
  return m3u;
}

async function updateGist(host) {
  if (!GITHUB_TOKEN) {
    console.log('[GIST] No GITHUB_TOKEN set, skipping Gist update');
    return;
  }
  const canales = readCanales();
  if (!canales.length) return;
  const m3u = buildM3u8(canales, host);
  try {
    const resp = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'lista_iptv.m3u8': { content: m3u } } })
    });
    if (resp.ok) {
      console.log(`[GIST] M3U8 updated (${canales.length} channels)`);
    } else {
      console.log(`[GIST] Error: ${resp.status}`);
    }
  } catch (e) {
    console.log(`[GIST] Error: ${e.message}`);
  }
}

async function refreshAllTokens() {
  const canales = readCanales();
  if (!canales.length) return;
  console.log(`\n[CRON] Refreshing tokens for ${canales.length} channels...`);
  let ok = 0, fail = 0;
  for (const ch of canales) {
    try {
      const result = await getTokenForChannel(ch.code, ch.name);
      if (result.error) {
        console.log(`[CRON] FAIL ${ch.name}: ${result.error}`);
        fail++;
      } else {
        console.log(`[CRON] OK ${ch.name} ${result.fromCache ? '(cache)' : '(fresh)'}`);
        ok++;
      }
    } catch (e) {
      console.log(`[CRON] ERROR ${ch.name}: ${e.message}`);
      fail++;
    }
  }
  console.log(`[CRON] Done: ${ok} OK, ${fail} failed`);
}

// Refresh tokens every 3 hours
setInterval(async () => {
  await refreshAllTokens();
}, 3 * 60 * 60 * 1000);

// === Keep-alive: ping ourselves every 14 min to prevent Render from sleeping ===
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    fetch(`${RENDER_URL}/health`).catch(() => {});
  }, 14 * 60 * 1000);
}

// Cleanup on shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  const host = RENDER_URL || `http://localhost:${PORT}`;
  console.log(`\n  IPTV Token Extractor running on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard.html`);
  if (RENDER_URL) console.log(`  Cloud URL: ${RENDER_URL}`);
  console.log('');

  // Upload M3U8 to Gist on startup (static /play URLs)
  await updateGist(host);

  // Pre-warm token cache in background (don't block startup)
  setTimeout(() => refreshAllTokens(), 5000);
});
