#!/usr/bin/env node
/**
 * MuAPI Prompt Generator - Local Server (zero dependencies)
 *
 * Serves the frontend from public/ and proxies API calls to MuAPI.
 * No Cloudflare, no auth, no database - catalog lives in data/catalog.json.
 *
 * Env:
 *   MUAPI_API_KEY   - your MuAPI key (required for generation)
 *   PORT            - default 3000
 *
 * Run: node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildCatalog } = require('./scripts/build-catalog');

// ── Tiny .env loader (no dotenv dependency) ──
(function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const PORT = parseInt(process.env.PORT || '3000', 10);
const MUAPI_API_KEY = process.env.MUAPI_API_KEY || '';
const MUAPI_BASE = (process.env.MUAPI_BASE_URL || 'https://api.muapi.ai/api/v1').replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CATALOG_PATH = path.join(__dirname, 'data', 'catalog.json');

// ── Catalog ──
let catalog = null;

function loadCatalog() {
  if (fs.existsSync(CATALOG_PATH)) {
    catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf-8'));
    console.log(`Catalog loaded: ${catalog.total} models (synced ${catalog.synced_at})`);
    return;
  }
  console.log('No catalog found - building from live MuAPI (first run)...');
  buildCatalog((m) => console.log('  ' + m))
    .then((data) => {
      fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(data));
      catalog = data;
      console.log(`Catalog built: ${data.total} models (${data.with_params} with param schemas)`);
    })
    .catch((e) => {
      console.error('FATAL: could not build catalog:', e.message);
      console.error('Check your internet connection and restart.');
      process.exit(1);
    });
}

// ── Helpers ──
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── API routes ──
async function handleApi(req, res, pathname, query) {
  // Health
  if (pathname === '/api/health') {
    return json(res, {
      status: 'ok',
      mode: 'local',
      models: catalog ? catalog.total : 0,
      synced_at: catalog ? catalog.synced_at : null,
      hasApiKey: !!MUAPI_API_KEY,
    });
  }

  if (!catalog) {
    return json(res, { error: 'Catalog still loading, try again in a moment' }, 503);
  }

  // Models list
  if (pathname === '/api/models' && req.method === 'GET') {
    let models = catalog.models;
    const category = query.get('category');
    const family = query.get('family');
    const groupOf = query.get('group_of');
    const q = (query.get('q') || '').toLowerCase();
    const limit = Math.min(parseInt(query.get('limit') || '1000', 10), 2000);
    if (category) models = models.filter((m) => m.category === category);
    if (family) models = models.filter((m) => m.family === family);
    if (groupOf) models = models.filter((m) => m.group_of === groupOf);
    if (q) {
      models = models.filter(
        (m) => m.id.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q) || (m.family || '').toLowerCase().includes(q)
      );
    }
    return json(res, { models: models.slice(0, limit), total: models.length });
  }

  // Single model + params
  const modelMatch = pathname.match(/^\/api\/models\/([^/]+)$/);
  if (modelMatch && req.method === 'GET') {
    const id = decodeURIComponent(modelMatch[1]);
    const model = catalog.models.find((m) => m.id === id);
    if (!model) return json(res, { error: 'Model not found' }, 404);
    const paramSchema = model.params ? { params: model.params, defaults: model.defaults || {} } : null;
    return json(res, { model, paramSchema });
  }

  // Categories
  if (pathname === '/api/categories' && req.method === 'GET') {
    const counts = {};
    for (const m of catalog.models) counts[m.category] = (counts[m.category] || 0) + 1;
    return json(res, {
      categories: Object.entries(counts)
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
    });
  }

  // Sync / Update models
  if (pathname === '/api/sync' && req.method === 'POST') {
    try {
      const previous = catalog ? catalog.total : 0;
      const data = await buildCatalog((m) => console.log('  [sync] ' + m));
      fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
      fs.writeFileSync(CATALOG_PATH, JSON.stringify(data));
      catalog = data;
      const added = data.total - previous;
      console.log(`[sync] Done: ${data.total} models (${added >= 0 ? '+' : ''}${added} vs previous), ${data.with_params} with params`);
      return json(res, {
        ok: true,
        total: data.total,
        with_params: data.with_params,
        added,
        previous,
        synced_at: data.synced_at,
      });
    } catch (e) {
      return json(res, { error: 'Sync failed: ' + e.message }, 502);
    }
  }

  // Generate (proxy)
  if (pathname === '/api/generate' && req.method === 'POST') {
    if (!MUAPI_API_KEY) return json(res, { error: 'MUAPI_API_KEY not set. Put it in .env or your environment.' }, 500);
    let body;
    try {
      body = JSON.parse((await readBody(req)).toString() || '{}');
    } catch {
      return json(res, { error: 'Invalid JSON body' }, 400);
    }
    const { modelId, params: userParams } = body;
    if (!modelId) return json(res, { error: 'modelId is required' }, 400);
    const model = catalog.models.find((m) => m.id === modelId);
    if (!model) return json(res, { error: 'Model not found in catalog' }, 404);

    const apiBody = buildApiBody(userParams || {});
    const apiUrl = model.endpoint.startsWith('http') ? model.endpoint : `https://api.muapi.ai${model.endpoint}`;

    let apiRes;
    try {
      apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'x-api-key': MUAPI_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(apiBody),
      });
    } catch (e) {
      return json(res, { error: 'Network error', message: e.message }, 502);
    }

    let responseText = '';
    try { responseText = await apiRes.text(); } catch { responseText = ''; }
    let data = null;
    try { data = JSON.parse(responseText); } catch { data = null; }

    if (!apiRes.ok) {
      const msg = (data && (data.detail || data.error || data.message)) || responseText || `HTTP ${apiRes.status}`;
      return json(res, { error: `MuAPI error (${apiRes.status})`, message: String(msg), status: apiRes.status }, apiRes.status);
    }

    return json(res, {
      requestId: data.request_id,
      status: data.status || 'processing',
      cost: data.cost,
      model: model.name,
      endpoint: model.endpoint,
    });
  }

  // Poll prediction
  const predMatch = pathname.match(/^\/api\/predictions\/([^/]+)$/);
  if (predMatch && req.method === 'GET') {
    if (!MUAPI_API_KEY) return json(res, { error: 'MUAPI_API_KEY not set' }, 500);
    const id = encodeURIComponent(decodeURIComponent(predMatch[1]));
    try {
      const apiRes = await fetch(`${MUAPI_BASE}/predictions/${id}/result`, {
        headers: { 'x-api-key': MUAPI_API_KEY },
      });
      const data = await apiRes.json();
      return json(res, data, apiRes.status);
    } catch (e) {
      return json(res, { error: 'Poll failed: ' + e.message }, 502);
    }
  }

  // Upload file (forward raw multipart body untouched)
  if (pathname === '/api/upload' && req.method === 'POST') {
    if (!MUAPI_API_KEY) return json(res, { error: 'MUAPI_API_KEY not set' }, 500);
    try {
      const bodyBuf = await readBody(req);
      const apiRes = await fetch(`${MUAPI_BASE}/upload_file`, {
        method: 'POST',
        headers: {
          'x-api-key': MUAPI_API_KEY,
          'Content-Type': req.headers['content-type'] || 'application/octet-stream',
        },
        body: bodyBuf,
      });
      const data = await apiRes.json();
      if (!apiRes.ok) return json(res, { error: 'Upload failed', details: data }, apiRes.status);
      return json(res, { url: data.url || data.output_url || data });
    } catch (e) {
      return json(res, { error: 'Upload error: ' + e.message }, 500);
    }
  }

  // Estimate
  if (pathname === '/api/estimate' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch { body = {}; }
    const model = catalog.models.find((m) => m.id === body.modelId);
    if (!model) return json(res, { error: 'Model not found' }, 404);
    if (!model.dynamic_pricing && model.cost) {
      return json(res, { estimatedCost: model.cost, currency: model.cost_currency, source: 'catalog' });
    }
    if (model.estimate_endpoint) {
      try {
        const apiRes = await fetch(`https://api.muapi.ai${model.estimate_endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(MUAPI_API_KEY ? { 'x-api-key': MUAPI_API_KEY } : {}),
          },
          body: JSON.stringify(buildApiBody(body.params || {})),
        });
        if (apiRes.ok) return json(res, { ...(await apiRes.json()), source: 'api' });
      } catch { /* fall through */ }
    }
    return json(res, { estimatedCost: model.cost, currency: model.cost_currency, source: 'catalog_fallback' });
  }

  return json(res, { error: 'Not found' }, 404);
}

// ── Build API request body from user params (same mapping as CF worker) ──
function buildApiBody(params) {
  const body = {};
  const ints = ['width', 'height', 'num_images', 'stylize', 'chaos', 'weird', 'seed'];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (k === 'duration') body.duration = typeof v === 'string' ? parseInt(v, 10) : v;
    else if (ints.includes(k)) body[k] = parseInt(v, 10);
    else if (k === 'images_list') body.images_list = Array.isArray(v) ? v : [v];
    else body[k] = v;
  }
  body.webhook_url = null;
  return body;
}

// ── Server ──
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) json(res, { error: e.message }, 500);
  }
});

loadCatalog();
server.listen(PORT, () => {
  console.log('');
  console.log('  MuAPI Prompt Generator (local)');
  console.log('  ─────────────────────────────');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  API key: ${MUAPI_API_KEY ? 'loaded' : 'MISSING - set MUAPI_API_KEY in .env'}`);
  console.log('');
});
