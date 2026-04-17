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
        proxyUrl: `https://proxy-iptv-q1aa.onrender.com/stream?url=${result.m3u8Url}`,
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
          ? `https://proxy-iptv-q1aa.onrender.com/stream?url=${result.m3u8Url}`
          : null
      });
    } catch (err) {
      results.push({ name: ch.name, code: ch.code, success: false, error: err.message });
    }
  }

  res.json({ results });
});

// === IPTV Player endpoint — M3UIPTV/Kodi calls this URL ===
// When the player requests a channel, extract token on demand and redirect to proxy
const tokenCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

app.get('/play/:code/:name', async (req, res) => {
  const { code, name } = req.params;
  const cacheKey = `${code}:${name}`;

  console.log(`\n[PLAY] Channel requested: ${name} (${code})`);

  // Check cache first
  const cached = tokenCache.get(cacheKey);
  if (cached && (Date.now() - cached.time) < CACHE_TTL) {
    console.log(`[PLAY] Cache hit (${((Date.now() - cached.time) / 1000 / 60).toFixed(0)}min old)`);
    return res.redirect(302, cached.proxyUrl);
  }

  // Extract fresh token
  const start = Date.now();
  try {
    const result = await extractToken(name, code);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (result.success) {
      const proxyUrl = `https://proxy-iptv-q1aa.onrender.com/stream?url=${result.m3u8Url}`;
      // Cache it
      tokenCache.set(cacheKey, { proxyUrl, time: Date.now() });
      console.log(`[PLAY] OK (${elapsed}s) — redirecting to proxy`);
      return res.redirect(302, proxyUrl);
    } else {
      console.log(`[PLAY] FAIL (${elapsed}s): ${result.error}`);
      res.status(503).set('Content-Type', 'text/plain').send(`# Token extraction failed: ${result.error}`);
    }
  } catch (err) {
    console.error(`[PLAY] Error: ${err.message}`);
    res.status(500).set('Content-Type', 'text/plain').send(`# Server error: ${err.message}`);
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

// === Health check (used by keep-alive and monitoring) ===
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), cache: tokenCache.size });
});

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
app.listen(PORT, () => {
  console.log(`\n  IPTV Token Extractor running on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard.html`);
  if (RENDER_URL) console.log(`  Cloud URL: ${RENDER_URL}`);
  console.log('');
});
