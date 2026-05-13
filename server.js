const express = require('express');
const cors = require('cors');
const path = require('path');
const { extractToken, closeBrowser } = require('./extractor');

const app = express();
app.use(cors());
app.use(express.json());

// === Rate limiting (protect against abuse & platform bans) ===
const rateLimits = new Map();
const RATE_WINDOW = 60 * 1000; // 1 minute window
const MAX_REQUESTS_PER_WINDOW = 60; // 60 req/min per IP
const MAX_EXTRACT_PER_WINDOW = 10; // 10 extractions/min per IP

function rateLimit(key, max) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateLimits.set(key, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > max;
}

// Clean up rate limit entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now - entry.start > RATE_WINDOW * 2) rateLimits.delete(key);
  }
}, 5 * 60 * 1000);

// Global rate limit middleware
app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  if (rateLimit(`global:${ip}`, MAX_REQUESTS_PER_WINDOW)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  next();
});

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

  // Rate limit extractions (expensive operation)
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  if (rateLimit(`extract:${ip}`, MAX_EXTRACT_PER_WINDOW)) {
    return res.status(429).json({ error: 'Too many extraction requests. Try again in a minute.' });
  }

  const start = Date.now();

  try {
    const token = await getTokenForChannel(code, name);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    if (token.error) {
      console.log(`[API] FAIL (${elapsed}s): ${token.error}`);
      res.json({ success: false, error: token.error, elapsed: `${elapsed}s` });
    } else {
      console.log(`[API] OK (${elapsed}s) ${token.fromCache ? '(cache)' : '(fresh)'}`);
      res.json({
        success: true,
        m3u8Url: token.m3u8Url,
        proxyUrl: `/stream?url=${token.m3u8Url}`,
        method: token.method || 'cached',
        fromCache: token.fromCache,
        elapsed: `${elapsed}s`
      });
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
      const token = await getTokenForChannel(ch.code, ch.name);
      results.push({
        name: ch.name,
        code: ch.code,
        success: !token.error,
        m3u8Url: token.m3u8Url,
        error: token.error,
        fromCache: token.fromCache,
        proxyUrl: token.m3u8Url ? `/stream?url=${token.m3u8Url}` : null
      });
    } catch (err) {
      results.push({ name: ch.name, code: ch.code, success: false, error: err.message });
    }
  }

  res.json({ results });
});

// === IPTV Player endpoint — M3UIPTV/Kodi calls this URL ===
// Smart token cache: reuse tokens until they actually expire (verified via HEAD request)
const tokenCache = new Map();
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours max TTL
const CACHE_VERIFY_INTERVAL = 5 * 60 * 1000; // Re-verify with HEAD every 5 min

async function verifyToken(m3u8Url) {
  try {
    const resp = await fetch(m3u8Url, {
      method: 'HEAD',
      headers: UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(5000)
    });
    // Only 401/403 means the token has definitively expired.
    // 5xx = channel backend offline (keep cached token to avoid re-extract loop).
    // 405 = HEAD not supported (keep cached token).
    return resp.status !== 401 && resp.status !== 403;
  } catch {
    // ECONNRESET / timeout — keep cached token (benefit of the doubt)
    return true;
  }
}

async function getTokenForChannel(code, name, { forceRefresh = false } = {}) {
  const cacheKey = `${code}:${name}`;
  const cached = tokenCache.get(cacheKey);

  if (cached && !forceRefresh) {
    const age = Date.now() - cached.time;

    // Within max TTL
    if (age < CACHE_TTL) {
      // If recently verified, serve directly
      if (Date.now() - cached.lastVerified < CACHE_VERIFY_INTERVAL) {
        cached.hits = (cached.hits || 0) + 1;
        return { m3u8Url: cached.m3u8Url, fromCache: true };
      }

      // Otherwise do a quick HEAD to verify it's still alive
      const alive = await verifyToken(cached.m3u8Url);
      if (alive) {
        cached.lastVerified = Date.now();
        cached.hits = (cached.hits || 0) + 1;
        return { m3u8Url: cached.m3u8Url, fromCache: true };
      }
      console.log(`[CACHE] Token expired for ${name}, re-extracting...`);
    }
  }

  // Extract fresh token
  const result = await extractToken(name, code);
  if (result.success) {
    tokenCache.set(cacheKey, {
      m3u8Url: result.m3u8Url,
      time: Date.now(),
      lastVerified: Date.now(),
      hits: 0,
      method: result.method
    });
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
  const decodedName = decodeURIComponent(name);
  console.log(`\n[PLAY] ${decodedName} (${code})`);

  try {
    let token = await getTokenForChannel(code, decodedName);
    if (token.error) {
      console.log(`[PLAY] FAIL: ${token.error}`);
      return res.status(503).type('text/plain').send(`# Error: ${token.error}`);
    }
    console.log(`[PLAY] Token ${token.fromCache ? 'from cache' : 'extracted (' + token.method + ')'}`);

    // Fetch upstream m3u8
    let upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });

    // If 401/403, token expired — extract fresh (max 2 retries)
    if (upstream.status === 403 || upstream.status === 401) {
      console.log(`[PLAY] Token expired (${upstream.status}), re-extracting...`);
      token = await getTokenForChannel(code, decodedName, { forceRefresh: true });
      if (token.error) return res.status(503).type('text/plain').send(`# Error: ${token.error}`);
      upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });

      // Second retry if still failing
      if (upstream.status === 403 || upstream.status === 401) {
        console.log(`[PLAY] Second attempt also expired, final retry...`);
        await new Promise(r => setTimeout(r, 2000));
        token = await getTokenForChannel(code, decodedName, { forceRefresh: true });
        if (token.error) return res.status(503).type('text/plain').send(`# Error: ${token.error}`);
        upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });
      }
    }

    // If 502/503/504, backend is overloaded — retry once with a fresh token after a short wait
    if (upstream.status === 502 || upstream.status === 503 || upstream.status === 504) {
      console.log(`[PLAY] Backend error (${upstream.status}), retrying with fresh token...`);
      await new Promise(r => setTimeout(r, 2000));
      token = await getTokenForChannel(code, decodedName, { forceRefresh: true });
      if (!token.error) {
        upstream = await fetch(token.m3u8Url, { headers: UPSTREAM_HEADERS });
      }
    }

    if (!upstream.ok) {
      console.log(`[PLAY] Upstream returned ${upstream.status} for ${decodedName}`);
      return res.status(upstream.status).type('text/plain').send(`# Canal no disponible (${upstream.status}): ${decodedName}`);
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

// Cached channel statuses from API (refreshed with Gist updates)
let cachedChannelStatuses = null;

app.get('/playlist.m3u8', async (req, res) => {
  const host = req.query.host || req.headers.host || 'localhost:3000';
  const protocol = req.query.protocol || (req.headers['x-forwarded-proto'] || req.protocol);
  const canalFile = path.join(__dirname, 'canales.txt');

  if (!fs.existsSync(canalFile)) {
    return res.status(404).send('#EXTM3U\n# canales.txt not found');
  }

  // Fetch statuses if not cached yet (non-blocking, best effort)
  if (!cachedChannelStatuses) {
    cachedChannelStatuses = await fetchChannelStatuses().catch(() => null);
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

    // Skip channels the API reports as offline
    if (cachedChannelStatuses) {
      const status = cachedChannelStatuses.get(name.toLowerCase());
      if (status === 'offline') continue;
    }

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

// === Real-time channel status dashboard ===
let statusCheckCache = { ts: 0, results: [] };
const STATUS_CHECK_TTL = 2 * 60 * 1000; // cache 2 minutes

async function checkAllChannelStatuses() {
  if (Date.now() - statusCheckCache.ts < STATUS_CHECK_TTL) {
    return statusCheckCache.results;
  }

  const canales = readCanales ? readCanales() : [];
  const CONCURRENCY = 8;
  const results = [];

  for (let i = 0; i < canales.length; i += CONCURRENCY) {
    const batch = canales.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (ch) => {
      const cacheKey = `${ch.code}:${ch.name}`;
      const cached = tokenCache.get(cacheKey);

      if (!cached || cached.error) {
        return { name: ch.name, group: ch.group, httpStatus: null, online: false, reason: 'sin token' };
      }

      try {
        const resp = await fetch(cached.m3u8Url, {
          method: 'HEAD',
          headers: UPSTREAM_HEADERS,
          signal: AbortSignal.timeout(5000)
        });
        // 200/206 = live, 405 = HEAD not allowed but stream exists, 403/401 = token expired
        const online = resp.status === 200 || resp.status === 206 || resp.status === 405;
        return { name: ch.name, group: ch.group, httpStatus: resp.status, online };
      } catch (e) {
        return { name: ch.name, group: ch.group, httpStatus: null, online: false, reason: 'timeout/error' };
      }
    }));
    results.push(...batchResults);
  }

  statusCheckCache = { ts: Date.now(), results };
  return results;
}

app.get('/status', async (req, res) => {
  const results = await checkAllChannelStatuses();
  const online = results.filter(r => r.online);
  const offline = results.filter(r => !r.online);

  if (req.query.format === 'json') {
    return res.json({ checked: new Date().toISOString(), online: online.length, offline: offline.length, channels: results });
  }

  // Group by group
  const groups = {};
  for (const r of results) {
    if (!groups[r.group]) groups[r.group] = [];
    groups[r.group].push(r);
  }

  const groupHtml = Object.entries(groups).map(([group, chs]) => {
    const rows = chs.map(r => {
      const dot = r.online ? '🟢' : '🔴';
      const statusBadge = r.httpStatus ? `<span style="color:#888;font-size:0.8em">${r.httpStatus}</span>` : `<span style="color:#888;font-size:0.8em">${r.reason || '-'}</span>`;
      return `<tr><td>${dot}</td><td>${r.name}</td><td>${statusBadge}</td></tr>`;
    }).join('');
    const groupOnline = chs.filter(c => c.online).length;
    const color = groupOnline === 0 ? '#f44336' : groupOnline === chs.length ? '#4caf50' : '#ff9800';
    return `<h3 style="color:${color};margin-top:20px">${group} (${groupOnline}/${chs.length})</h3><table>${rows}</table>`;
  }).join('');

  const ts = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  res.type('text/html').send(`<!DOCTYPE html><html>
<head>
  <title>Estado Canales IPTV</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="120">
  <style>
    body{font-family:sans-serif;background:#121212;color:#eee;padding:20px;max-width:800px;margin:auto}
    h1{color:#fff}h3{margin-bottom:6px}
    table{border-collapse:collapse;width:100%;margin-bottom:10px}
    td{padding:6px 10px;border-bottom:1px solid #222}
    tr:hover{background:#1e1e1e}
    .summary{font-size:1.1em;margin:10px 0 24px}
    .on{color:#4caf50}.off{color:#f44336}.ts{color:#666;font-size:0.8em}
    a{color:#90caf9;text-decoration:none}
  </style>
</head>
<body>
  <h1>📺 Estado en tiempo real</h1>
  <div class="summary">
    <span class="on">🟢 ${online.length} emitiendo ahora</span> &nbsp;|&nbsp;
    <span class="off">🔴 ${offline.length} offline</span>
    <span class="ts"> — ${ts} · actualiza cada 2 min</span>
  </div>
  <p style="color:#888;font-size:0.85em">Los canales 🔴 fuera de evento (Champions, LaLiga, DAZN) volverán a estar disponibles cuando haya partido. <a href="/epg">Ver próximos partidos →</a></p>
  ${groupHtml}
</body></html>`);
});

// === EPG: próximos eventos deportivos (desde API pública) ===
app.get('/epg', async (req, res) => {
  // Fetch upcoming matches from open football data APIs
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const in7days = new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString().split('T')[0];

  let fixtures = [];
  const errors = [];

  // La Liga (competition id 140) + Champions League (2) from football-data.org (free tier)
  const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '';
  const competitions = [
    { id: 2, name: 'Champions League', channel: 'M Liga de Campeones' },
    { id: 140, name: 'La Liga', channel: 'M LaLiga / DAZN LaLiga' },
    { id: 78, name: 'Bundesliga', channel: 'DAZN' },
    { id: 135, name: 'Serie A', channel: 'DAZN' },
  ];

  for (const comp of competitions) {
    try {
      const url = `https://api.football-data.org/v4/competitions/${comp.id}/matches?dateFrom=${today}&dateTo=${in7days}&status=SCHEDULED`;
      const r = await fetch(url, {
        headers: FOOTBALL_API_KEY
          ? { 'X-Auth-Token': FOOTBALL_API_KEY }
          : { 'X-Auth-Token': '' },
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) {
        const data = await r.json();
        for (const m of (data.matches || [])) {
          const kickoff = new Date(m.utcDate);
          const localTime = kickoff.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          fixtures.push({
            comp: comp.name,
            channel: comp.channel,
            home: m.homeTeam?.name || '?',
            away: m.awayTeam?.name || '?',
            time: localTime,
            ts: kickoff.getTime()
          });
        }
      }
    } catch (e) {
      errors.push(`${comp.name}: ${e.message}`);
    }
  }

  fixtures.sort((a, b) => a.ts - b.ts);

  if (req.query.format === 'json') {
    return res.json({ from: today, to: in7days, fixtures, errors });
  }

  if (!FOOTBALL_API_KEY) {
    return res.type('text/html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>EPG</title>
    <style>body{font-family:sans-serif;background:#121212;color:#eee;padding:20px;max-width:800px;margin:auto}a{color:#90caf9}</style></head><body>
    <h1>📅 Próximos partidos</h1>
    <div style="background:#1e1e1e;border:1px solid #ff9800;padding:16px;border-radius:8px;margin:20px 0">
      <b style="color:#ff9800">⚠️ Falta configurar FOOTBALL_DATA_API_KEY</b><br><br>
      Para ver el calendario de partidos, crea una cuenta gratuita en 
      <a href="https://www.football-data.org/" target="_blank">football-data.org</a> 
      (plan gratuito: 10 peticiones/min, datos de La Liga, Champions, etc.)<br><br>
      Luego añade la variable de entorno en Railway:<br>
      <code style="background:#333;padding:4px 8px;border-radius:4px">FOOTBALL_DATA_API_KEY = tu_api_key</code>
    </div>
    <p>Mientras tanto, puedes consultar los horarios en:</p>
    <ul>
      <li><a href="https://www.laliga.com/calendar" target="_blank">LaLiga — calendario oficial</a></li>
      <li><a href="https://www.uefa.com/uefachampionsleague/fixtures/" target="_blank">UEFA Champions League — fixtures</a></li>
      <li><a href="https://www.dazn.com/es-ES/schedule" target="_blank">DAZN España — programación</a></li>
      <li><a href="https://ver.movistarplus.es/programacion/" target="_blank">Movistar+ — programación</a></li>
    </ul>
    <p><a href="/status">← Volver al estado de canales</a></p>
    </body></html>`);
  }

  const rows = fixtures.map(f =>
    `<tr><td>${f.time}</td><td><b>${f.home}</b> vs <b>${f.away}</b></td><td style="color:#aaa">${f.comp}</td><td style="color:#90caf9">${f.channel}</td></tr>`
  ).join('');

  res.type('text/html').send(`<!DOCTYPE html><html>
<head>
  <meta charset="utf-8"><title>EPG - Próximos partidos</title>
  <style>
    body{font-family:sans-serif;background:#121212;color:#eee;padding:20px;max-width:900px;margin:auto}
    h1{color:#fff}table{border-collapse:collapse;width:100%}
    th{text-align:left;padding:8px 12px;background:#333}
    td{padding:8px 12px;border-bottom:1px solid #222}
    tr:hover{background:#1e1e1e}a{color:#90caf9;text-decoration:none}
  </style>
</head>
<body>
  <h1>📅 Próximos partidos (próximos 7 días)</h1>
  <p style="color:#888">Los canales estarán disponibles durante estos eventos. <a href="/status">← Estado actual de canales</a></p>
  ${fixtures.length === 0
    ? '<p style="color:#f44336">No se encontraron partidos próximos.</p>'
    : `<table><thead><tr><th>Hora (Madrid)</th><th>Partido</th><th>Competición</th><th>Canal IPTV</th></tr></thead><tbody>${rows}</tbody></table>`
  }
  ${errors.length ? `<p style="color:#888;font-size:0.8em">Errores: ${errors.join(', ')}</p>` : ''}
</body></html>`);
});

// === Cache stats API — dashboard uses this ===
app.get('/api/cache-stats', (req, res) => {
  const stats = [];
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    const [code, ...nameParts] = key.split(':');
    const name = nameParts.join(':');
    const age = now - entry.time;
    const ttlRemaining = Math.max(0, CACHE_TTL - age);
    stats.push({
      name,
      code,
      age: Math.round(age / 1000),
      ttlRemaining: Math.round(ttlRemaining / 1000),
      hits: entry.hits || 0,
      method: entry.method || 'unknown',
      lastVerified: Math.round((now - entry.lastVerified) / 1000),
      alive: ttlRemaining > 0
    });
  }
  stats.sort((a, b) => b.ttlRemaining - a.ttlRemaining);
  res.json({
    total: stats.length,
    uptime: Math.round(process.uptime()),
    stats
  });
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

// ─── Channel metadata: tvg-id and logos ───────────────────────────────────────
const CHANNEL_LOGOS = {
  'DAZN LaLiga':           'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'DAZN LaLiga 2':         'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'M LALIGA':              'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/LaLiga_logo_2023.svg/200px-LaLiga_logo_2023.svg.png',
  'M LALIGA 2':            'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/LaLiga_logo_2023.svg/200px-LaLiga_logo_2023.svg.png',
  'Gol Play':              'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/LaLiga_logo_2023.svg/200px-LaLiga_logo_2023.svg.png',
  'DAZN 1':                'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'DAZN 2':                'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'DAZN 3':                'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'DAZN 4':                'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5e/DAZN_logo.svg/200px-DAZN_logo.svg.png',
  'DAZN F1':               'https://upload.wikimedia.org/wikipedia/commons/thumb/3/33/F1.svg/200px-F1.svg.png',
  'Euro Sport 1':          'https://upload.wikimedia.org/wikipedia/commons/thumb/c/ce/Eurosport_1_Logo_2015.svg/200px-Eurosport_1_Logo_2015.svg.png',
  'Euro Sport 2':          'https://upload.wikimedia.org/wikipedia/commons/thumb/9/92/Eurosport_2_logo_2015.svg/200px-Eurosport_2_logo_2015.svg.png',
  'Teledeporte':           'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d4/Teledeporte.svg/200px-Teledeporte.svg.png',
  'TVE La 1':              'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Logo_TVE_2021.svg/200px-Logo_TVE_2021.svg.png',
  'TVE La 2':              'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fc/La_2_television_espanola_logo.svg/200px-La_2_television_espanola_logo.svg.png',
  'beIN SPORTS N':         'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/BeIN_SPORTS_logo.svg/200px-BeIN_SPORTS_logo.svg.png',
  'beIN SPORTS XTRA':      'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/BeIN_SPORTS_logo.svg/200px-BeIN_SPORTS_logo.svg.png',
};

// Generate a stable tvg-id from channel name
function toTvgId(name) {
  return name.toLowerCase()
    .replace(/[áàâä]/g, 'a').replace(/[éèêë]/g, 'e')
    .replace(/[íìîï]/g, 'i').replace(/[óòôö]/g, 'o')
    .replace(/[úùûü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    + '.iptv';
}

function buildM3u8(canales, host) {
  let m3u = `#EXTM3U url-tvg="${host}/epg.xml" x-tvg-url="${host}/epg.xml"\n`;
  for (const ch of canales) {
    const tvgId = toTvgId(ch.name);
    const logo = CHANNEL_LOGOS[ch.name] || '';
    m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${ch.name}" tvg-logo="${logo}" group-title="${ch.group}",${ch.name}\n`;
    m3u += `${host}/play/${ch.code}/${encodeURIComponent(ch.name)}\n`;
  }
  return m3u;
}

// ─── XMLTV EPG endpoint ────────────────────────────────────────────────────────
// Maps football-data.org competition IDs to our IPTV channels (in priority order)
const COMP_CHANNEL_MAP = {
  2001: { name: 'Champions League',      channels: ['m-liga-de-campeones-1.iptv','m-liga-de-campeones-2.iptv','m-liga-de-campeones-3.iptv','m-liga-de-campeones-4.iptv','m-liga-de-campeones-5.iptv','m-liga-de-campeones-6.iptv','m-liga-de-campeones-7.iptv','m-liga-de-campeones-8.iptv'] },
  2014: { name: 'La Liga',               channels: ['m-laliga.iptv','m-laliga-2.iptv','dazn-laliga.iptv','dazn-laliga-2.iptv','gol-play.iptv'] },
  2002: { name: 'Bundesliga',            channels: ['dazn-1.iptv','dazn-2.iptv'] },
  2019: { name: 'Serie A',               channels: ['dazn-3.iptv','dazn-4.iptv'] },
  2003: { name: 'Eredivisie',            channels: ['dazn-1.iptv'] },
  2015: { name: 'Ligue 1',               channels: ['dazn-2.iptv'] },
  2017: { name: 'Primeira Liga',         channels: ['dazn-3.iptv'] },
};

let epgXmlCache = { ts: 0, xml: null };
const EPG_XML_CACHE_TTL = 60 * 60 * 1000; // 1 hour

function xmltvDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth()+1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00 +0000`;
}

async function buildEpgXml(canales) {
  if (epgXmlCache.xml && Date.now() - epgXmlCache.ts < EPG_XML_CACHE_TTL) {
    return epgXmlCache.xml;
  }

  const FOOTBALL_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '';
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const in14days = new Date(now.getTime() + 14 * 24 * 3600 * 1000).toISOString().split('T')[0];

  // Channel definitions
  const channelDefs = canales.map(ch =>
    `  <channel id="${toTvgId(ch.name)}">\n    <display-name lang="es">${ch.name}</display-name>\n  </channel>`
  ).join('\n');

  // Fetch fixtures grouped by competition
  const programmes = [];

  if (FOOTBALL_API_KEY) {
    for (const [compId, compInfo] of Object.entries(COMP_CHANNEL_MAP)) {
      try {
        const url = `https://api.football-data.org/v4/competitions/${compId}/matches?dateFrom=${today}&dateTo=${in14days}&status=SCHEDULED,LIVE`;
        const r = await fetch(url, {
          headers: { 'X-Auth-Token': FOOTBALL_API_KEY },
          signal: AbortSignal.timeout(6000)
        });
        if (!r.ok) continue;
        const data = await r.json();
        const matches = data.matches || [];

        // Group matches by timeslot (same day, within 30min of each other)
        // Assign to channels in order
        const slots = {};
        for (const m of matches) {
          const slotKey = m.utcDate.substring(0, 13); // YYYY-MM-DDTHH
          if (!slots[slotKey]) slots[slotKey] = [];
          slots[slotKey].push(m);
        }

        for (const [, slotMatches] of Object.entries(slots)) {
          slotMatches.forEach((m, idx) => {
            const channelId = compInfo.channels[idx % compInfo.channels.length];
            const start = new Date(m.utcDate);
            const end = new Date(start.getTime() + 2 * 3600 * 1000); // 2h duration
            const title = `${m.homeTeam?.name || '?'} vs ${m.awayTeam?.name || '?'}`;
            const desc = `${compInfo.name} · ${start.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`;
            programmes.push(
              `  <programme start="${xmltvDate(start)}" stop="${xmltvDate(end)}" channel="${channelId}">\n    <title lang="es">${title}</title>\n    <desc lang="es">${desc}</desc>\n    <category lang="es">Fútbol</category>\n  </programme>`
            );
          });
        }
      } catch (e) {
        console.log(`[EPG XML] Error comp ${compId}: ${e.message}`);
      }
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv generator-info-name="iptv-bot">\n${channelDefs}\n${programmes.join('\n')}\n</tv>`;
  epgXmlCache = { ts: Date.now(), xml };
  return xml;
}

app.get('/epg.xml', async (req, res) => {
  const canales = readCanales();
  const xml = await buildEpgXml(canales);
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Access-Control-Allow-Origin', '*');
  res.send(xml);
});

// Fetch channel online status from the cdnlivetv API
async function fetchChannelStatuses() {
  try {
    const r = await fetch('https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    const channels = data.channels || (Array.isArray(data) ? data : []);
    // Build a map: lowercase name → status
    const statusMap = new Map();
    for (const ch of channels) {
      statusMap.set(ch.name.toLowerCase(), ch.status || 'unknown');
    }
    return statusMap;
  } catch (e) {
    console.log(`[API] Could not fetch channel statuses: ${e.message}`);
    return null;
  }
}

async function updateGist(host) {
  if (!GITHUB_TOKEN) {
    console.log('[GIST] No GITHUB_TOKEN set, skipping Gist update');
    return;
  }
  let canales = readCanales();
  if (!canales.length) return;

  // Filter out channels the API knows are offline
  const statuses = await fetchChannelStatuses();
  if (statuses) {
    cachedChannelStatuses = statuses; // update shared cache
    const before = canales.length;
    canales = canales.filter(ch => {
      const status = statuses.get(ch.name.toLowerCase());
      return status !== 'offline'; // include 'online', 'unknown', or not in API
    });
    console.log(`[GIST] Status filter: ${before} → ${canales.length} channels (removed ${before - canales.length} offline)`);
  }

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
  const CONCURRENCY = 3;

  for (let i = 0; i < canales.length; i += CONCURRENCY) {
    const batch = canales.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (ch) => {
        try {
          const result = await getTokenForChannel(ch.code, ch.name);
          if (result.error) {
            console.log(`[CRON] FAIL ${ch.name}: ${result.error}`);
            return false;
          } else {
            console.log(`[CRON] OK ${ch.name} ${result.fromCache ? '(cache)' : '(fresh)'}`);
            return true;
          }
        } catch (e) {
          console.log(`[CRON] ERROR ${ch.name}: ${e.message}`);
          return false;
        }
      })
    );
    results.forEach(r => r.status === 'fulfilled' && r.value ? ok++ : fail++);
    // Stagger batches to avoid request spikes
    if (i + CONCURRENCY < canales.length) await new Promise(r => setTimeout(r, 3000));
  }
  console.log(`[CRON] Done: ${ok} OK, ${fail} failed (cache size: ${tokenCache.size})`);
}

// Refresh tokens every 4 hours (aligned with cache TTL, less aggressive)
setInterval(async () => {
  await refreshAllTokens();
}, 4 * 60 * 60 * 1000);

// Cleanup on shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await closeBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  console.log('\nSIGTERM received, shutting down...');
  await closeBrowser();
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : process.env.PUBLIC_URL || `http://localhost:${PORT}`;

app.listen(PORT, async () => {
  console.log(`\n  IPTV Token Extractor running on http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/dashboard.html`);
  console.log(`  Public URL: ${PUBLIC_URL}`);
  console.log('');

  // Upload M3U8 to Gist on startup (static /play URLs)
  await updateGist(PUBLIC_URL);

  // Pre-warm token cache in background (staggered start, don't blast requests)
  setTimeout(() => refreshAllTokens(), 10000);
});
