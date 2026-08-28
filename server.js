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
const LLM_CONFIG_PATH = path.join(__dirname, 'data', 'llm.json');
const PROMPTS_PATH = path.join(__dirname, 'data', 'prompts.json');

const DEFAULT_LLM_PROVIDERS = [
  { baseUrl: 'https://api.venice.ai/api/v1', model: 'dolphin-mixtral', apiKey: '' },
  { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', apiKey: '' },
];
const ENHANCER_TEMPLATE = `refine the following [Media Generation Type] prompt, specifically to optimize it for [Model]. This should include determining the optimal prompt length, or at least the ideal minimum and maximum word counts, determining whether the model excels with keyword based prompts or full narrative descriptions, what types of prompts work best (describe everything vs just describe movement, etc), whether it accepts timestamp direction (at 00:05, do this, at 00:10 do that, etc) and if it does add these timestamp directions based on the total length of the video (as input by the user) and estimating the time it would take for the described actions in the scene to take place, determine if a certain camera lens or videography style works well if called out for the specific model, translate any vague camera movement directions into videographer jargon (dolly out, orbital, chase cam, etc).  The video will be generated at [resolution] and [aspect ratio] (only include this if it would benefit the prompt for this model.  \nif [Model] includes audio generation, insert appropriate sound effect cues and format any dialogue into the most AI friendly format.`;

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

// ── Enhancer helpers (shared logic with Worker) ──
function hasDialogueCues(s) {
  return /["\u201c\u201d].*["\u201c\u201d]|dialogue|says\s+["\u201c]|speaking|voice:/i.test(s);
}
function deriveMediaTypeLocal(model) {
  if (!model) return 'text-to-video';
  const id = model.id || '';
  const cat = (model.category || '').toLowerCase();
  if (id.includes('reference-to-video')) return 'reference-to-video';
  if (id.includes('image-to-video') || id.includes('-i2v') || id.includes('i2v')) return 'image-to-video';
  if (id.includes('text-to-video') || id.includes('-t2v')) return 'text-to-video';
  if (id.includes('image-to-image') || id.includes('-i2i') || cat.includes('image to image')) return 'image-to-image';
  if (cat.includes('text to image')) return 'text-to-image';
  if (cat.includes('video to video') || cat.includes('video: edit')) return 'video-to-video';
  if (cat.includes('audio')) return 'audio generation';
  if (cat.includes('3d')) return 'text-to-3d';
  return cat.replace(/ /g, '-') || 'text-to-video';
}
function buildEnhancerSystemPrompt(raw, ctx) {
  let t = ENHANCER_TEMPLATE.replace('[Media Generation Type]', ctx.mediaType).replace('[Model]', ctx.model);
  const resAspect = [];
  if (ctx.resolution) resAspect.push(ctx.resolution);
  if (ctx.aspectRatio) resAspect.push(ctx.aspectRatio);
  if (resAspect.length) {
    t = t.replace('[resolution] and [aspect ratio]', resAspect.join(' and '));
  } else {
    t = t.replace(/The video will be generated at \[resolution\] and \[aspect ratio\][^\n]*\n?/, '');
  }
  if (!ctx.hasAudio) {
    t = t.replace(/if \[Model\] includes audio generation,.*format\./, '').trim();
  } else {
    t = t.replace(/\[Model\]/g, ctx.model);
  }
  if (!hasDialogueCues(raw)) {
    t = t.replace(/and format any dialogue into the most AI friendly format\./, ' (dialogue formatting not needed for this prompt).');
  }
  if (ctx.duration && ctx.mediaType.includes('video')) {
    t += `\nVideo length: ${ctx.duration} seconds — add timestamp directions accordingly.`;
  }
  return t;
}
function getLLMConfigLocal() {
  try {
    if (fs.existsSync(LLM_CONFIG_PATH)) {
      const j = JSON.parse(fs.readFileSync(LLM_CONFIG_PATH, 'utf-8'));
      if (j.providers && j.providers.length) return j;
    }
  } catch {}
  const veniceKey = process.env.VENICE_API_KEY || '';
  const openrouterKey = process.env.OPENROUTER_API_KEY || '';
  return {
    providers: DEFAULT_LLM_PROVIDERS.map((p) => {
      const isVenice = (p.baseUrl || '').includes('venice.ai');
      const envKey = isVenice ? veniceKey : openrouterKey;
      return { ...p, apiKey: envKey || p.apiKey };
    }),
  };
}
function redactLLM(cfg) {
  return { providers: (cfg.providers || []).map((p) => ({ ...p, apiKey: p.apiKey ? '***' : '' })) };
}
function loadPrompts() {
  try {
    if (fs.existsSync(PROMPTS_PATH)) return JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf-8'));
  } catch {}
  return [];
}
function savePrompts(arr) {
  try {
    fs.mkdirSync(path.dirname(PROMPTS_PATH), { recursive: true });
    fs.writeFileSync(PROMPTS_PATH, JSON.stringify(arr.slice(0, 500)));
  } catch {}
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

    const apiBody = buildApiBody(modelId, userParams || {});
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
          body: JSON.stringify(buildApiBody(body.modelId, body.params || {})),
        });
        if (apiRes.ok) return json(res, { ...(await apiRes.json()), source: 'api' });
      } catch { /* fall through */ }
    }
    return json(res, { estimatedCost: model.cost, currency: model.cost_currency, source: 'catalog_fallback' });
  }

  // LLM config
  if (pathname === '/api/llm-config' && req.method === 'GET') {
    return json(res, { config: redactLLM(getLLMConfigLocal()) });
  }
  if (pathname === '/api/llm-config' && req.method === 'PUT') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch { return json(res, { error: 'Invalid JSON' }, 400); }
    const incoming = body.config;
    if (!incoming || !Array.isArray(incoming.providers) || !incoming.providers.length) {
      return json(res, { error: 'config.providers must be a non-empty array' }, 400);
    }
    const existing = getLLMConfigLocal();
    const providers = incoming.providers.map((p, i) => {
      let apiKey = (p.apiKey || '').trim();
      if (apiKey === '***' && existing.providers[i]) apiKey = existing.providers[i].apiKey;
      if (!p.model || !p.model.trim()) return null;
      return { baseUrl: (p.baseUrl || 'https://openrouter.ai/api/v1').trim().replace(/\/$/, ''), model: p.model.trim(), apiKey };
    }).filter(Boolean);
    if (!providers.length) return json(res, { error: 'At least one provider with a model is required' }, 400);
    const toSave = { providers };
    try { fs.mkdirSync(path.dirname(LLM_CONFIG_PATH), { recursive: true }); fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(toSave)); } catch {}
    return json(res, { ok: true, config: redactLLM(toSave) });
  }

  // Enhance (streaming)
  if (pathname === '/api/enhance' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); } catch { return json(res, { error: 'Invalid JSON' }, 400); }
    const rawPrompt = (body.rawPrompt || '').trim();
    const modelId = (body.modelId || '').trim();
    const userParams = body.params || {};
    if (!rawPrompt) return json(res, { error: 'rawPrompt is required' }, 400);
    if (!modelId) return json(res, { error: 'modelId is required' }, 400);
    const model = catalog.models.find((m) => m.id === modelId);
    if (!model) return json(res, { error: 'Model not found' }, 404);
    const mediaType = deriveMediaTypeLocal(model);
    const aspectRatio = userParams.aspect_ratio || null;
    const resolution = userParams.resolution || (userParams.width && userParams.height ? `${userParams.width}x${userParams.height}` : null) || null;
    const duration = userParams.duration || null;
    const hasAudio = !!(model.id.includes('seedance') || model.id.includes('wan') || model.family === 'seedance' || model.group_of === 'audio' || model.id.includes('audio'));
    const ctx = { model: model.id, mediaType, aspectRatio, resolution, duration, hasAudio };
    const systemPrompt = buildEnhancerSystemPrompt(rawPrompt, ctx);
    const llmCfg = getLLMConfigLocal();
    let lastErr = null;
    for (const p of llmCfg.providers) {
      const baseUrl = (p.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
      const isVenice = baseUrl.includes('venice.ai');
      const apiKey = p.apiKey || (isVenice ? process.env.VENICE_API_KEY : process.env.OPENROUTER_API_KEY) || '';
      if (!apiKey) { lastErr = 'Missing API key for ' + p.model; continue; }
      let llmRes;
      try {
        llmRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': 'http://localhost:3000',
            'X-Title': 'MuAPI Prompt Generator Local',
          },
          body: JSON.stringify({ model: p.model, stream: true, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Raw prompt: """${rawPrompt}"""` }] }),
        });
      } catch (e) { lastErr = e.message; continue; }
      if (!llmRes.ok) {
        const txt = await llmRes.text().catch(() => '');
        let j = null; try { j = JSON.parse(txt); } catch { j = null; }
        lastErr = (j && (j.error?.message || j.error)) || txt || `HTTP ${llmRes.status}`;
        continue;
      }
      // Stream to client
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Provider-Used': baseUrl,
        'X-Model-Used': p.model,
      });
      let fullEnhanced = '';
      const reader = llmRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (fullEnhanced) {
              try { const arr = loadPrompts(); arr.unshift({ id: Date.now(), kind: 'enhanced', prompt: rawPrompt, enhanced: fullEnhanced, model_id: model.id, params_json: JSON.stringify(userParams), llm_provider: baseUrl, llm_model: p.model, created_at: new Date().toISOString() }); savePrompts(arr); } catch {}
            }
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(value);
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]' || !d) continue;
            try { const j = JSON.parse(d); const delta = j.choices?.[0]?.delta?.content || ''; if (delta) fullEnhanced += delta; } catch {}
          }
        }
      } catch (e) {
        try { res.end(); } catch {}
      }
      return;
    }
    return json(res, { error: 'All LLM providers failed', message: String(lastErr || 'unknown') }, 502);
  }

  // Prompts list
  if (pathname === '/api/prompts' && req.method === 'GET') {
    const kind = query.get('kind') || 'enhanced';
    const limit = Math.min(parseInt(query.get('limit') || '50', 10), 200);
    try {
      const all = loadPrompts();
      const filtered = kind === 'all' ? all : all.filter((p) => p.kind === kind);
      return json(res, { prompts: filtered.slice(0, limit), total: filtered.length });
    } catch { return json(res, { prompts: [], total: 0 }); }
  }

  return json(res, { error: 'Not found' }, 404);
}

// ── Build API request body — generic, per-model capability-aware ──
function buildApiBody(modelId, params) {
  const model = catalog ? catalog.models.find((m) => m.id === modelId) : null;
  const schemaParams = model && model.params ? model.params : null;
  const body = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    const spec = schemaParams ? schemaParams[k] : null;
    if (spec) {
      if (spec.type === 'number') {
        const n = typeof v === 'string' ? Number(v) : v;
        if (!Number.isNaN(n)) body[k] = n;
        continue;
      }
      if (spec.type === 'boolean') {
        body[k] = v === true || v === 'true' || v === 1 || v === '1';
        continue;
      }
      if (spec.type === 'array' && !Array.isArray(v)) { body[k] = [v]; continue; }
    } else {
      if (['width', 'height', 'num_images', 'stylize', 'chaos', 'weird', 'seed'].includes(k)) {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) { body[k] = n; continue; }
      }
      if (k === 'duration' && typeof v === 'string') {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n)) { body[k] = n; continue; }
      }
      if (k === 'images_list' && !Array.isArray(v)) { body[k] = [v]; continue; }
    }
    body[k] = v;
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
