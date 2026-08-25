#!/usr/bin/env node
/**
 * build-catalog.js
 *
 * Builds data/catalog.json from the live MuAPI catalog + OpenAPI spec.
 * Used at startup (if catalog missing) and by POST /api/sync (the
 * "Update Models" feature) to pull newly released models and their
 * parameter schemas.
 *
 * Zero dependencies. Run directly: node scripts/build-catalog.js
 */

const fs = require('fs');
const path = require('path');

const CATALOG_URL = 'https://api.muapi.ai/api/v1/models';
const OPENAPI_URL = 'https://api.muapi.ai/openapi.json';
const OUTPUT = path.join(__dirname, '..', 'data', 'catalog.json');

// Suffixes stripped when matching catalog names to OpenAPI paths
const STRIP_SUFFIXES = [
  '-text-to-image', '-text-to-video', '-image-to-video', '-image-to-image',
  '-text-to-3d', '-text-to-audio', '-reference-to-video', '-reference-to-image',
  '-t2i', '-t2v', '-i2v', '-i2i', '-t2a',
  '-image', '-video', '-audio',
];

const TAG_TO_CATEGORY = {
  'Image: Text-to-Image': 'Text to Image',
  'Image: Edit & Reference': 'Image to Image',
  'Image: Enhance': 'Image to Image',
  'Video: Text-to-Video': 'Text to Video',
  'Video: Image-to-Video': 'Image to Video',
  'Video: Edit & Effects': 'Video to Video',
  'Video: Lipsync': 'Audio to Video',
  'Video: Avatars': 'Audio to Video',
  'Video: Storyboard': 'Text to Video',
  'Audio': 'Text to Audio',
  '3D Generation': 'Text to 3D',
  'LLM / Multimodal': 'Text to Text',
  'API': 'Other',
  'Utilities': 'Other',
  'Creative Agent': 'Other',
  'Account': 'Other',
  'Other': 'Other',
};

const SKIP_PREFIXES = ['predictions/', 'account/', 'keys', 'upload_file', 'agent-skills'];
const SKIP_EXACT = ['predictions', 'account', 'keys', 'upload_file', 'models'];

function mapType(t) {
  const m = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', array: 'array', object: 'object' };
  return m[t] || t || 'string';
}

function resolveRef(ref, schemas) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  return schemas[ref.replace('#/components/schemas/', '')] || null;
}

function extractProperty(name, prop, schemas, requiredFields) {
  const result = { type: 'string' };
  if (prop.$ref) {
    const resolved = resolveRef(prop.$ref, schemas);
    result.type = 'object';
    result.$ref = prop.$ref.replace('#/components/schemas/', '');
    if (resolved && resolved.title) result.title = resolved.title;
  } else if (prop.anyOf) {
    const nonNull = prop.anyOf.find((p) => p.type !== 'null');
    if (nonNull) {
      if (nonNull.$ref) {
        result.type = 'object';
        result.$ref = nonNull.$ref.replace('#/components/schemas/', '');
      } else {
        result.type = mapType(nonNull.type);
        if (nonNull.format) result.format = nonNull.format;
        if (nonNull.enum) result.options = nonNull.enum;
        if (nonNull.minimum !== undefined) result.min = nonNull.minimum;
        if (nonNull.maximum !== undefined) result.max = nonNull.maximum;
        if (nonNull.minLength !== undefined) result.minLength = nonNull.minLength;
        if (nonNull.maxLength !== undefined) result.maxLength = nonNull.maxLength;
      }
    }
    result.nullable = true;
  } else if (prop.allOf) {
    const merged = prop.allOf.find((p) => p.$ref || p.type);
    if (merged) return extractProperty(name, merged, schemas, requiredFields);
  } else {
    result.type = mapType(prop.type);
    if (prop.format) result.format = prop.format;
    if (prop.enum) result.options = prop.enum;
    if (prop.minimum !== undefined) result.min = prop.minimum;
    if (prop.maximum !== undefined) result.max = prop.maximum;
    if (prop.minLength !== undefined) result.minLength = prop.minLength;
    if (prop.maxLength !== undefined) result.maxLength = prop.maxLength;
    if (prop.items) {
      result.items = {};
      if (prop.items.$ref) result.items.$ref = prop.items.$ref.replace('#/components/schemas/', '');
      else if (prop.items.type) result.items.type = mapType(prop.items.type);
    }
  }
  if (requiredFields.includes(name)) result.required = true;
  if (prop.default !== undefined) result.default = prop.default;
  if (prop.title) result.title = prop.title;
  if (prop.description) result.description = prop.description;
  return result;
}

function extractSchema(pathItem, schemas) {
  const post = pathItem && pathItem.post;
  if (!post || !post.requestBody) return null;
  const content = post.requestBody.content;
  if (!content || !content['application/json']) return null;
  let schema = content['application/json'].schema;
  if (!schema) return null;
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, schemas);
    if (!resolved) return null;
    schema = resolved;
  }
  const requiredFields = schema.required || [];
  const params = {};
  const defaults = {};
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    if (name === 'webhook_url') continue;
    const spec = extractProperty(name, prop, schemas, requiredFields);
    params[name] = spec;
    if (spec.default !== undefined) defaults[name] = spec.default;
  }
  return { params, defaults };
}

function inferGroupOf(category) {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes('image') && !c.includes('video')) return 'image';
  if (c.includes('video')) return 'video';
  if (c.includes('audio') || c.includes('music') || c.includes('speech')) return 'audio';
  if (c.includes('3d')) return '3d';
  if (c.includes('text') && !c.includes('image') && !c.includes('video')) return 'text';
  return 'other';
}

function buildOpenAPILookup(paths) {
  const lookup = {};
  for (const pathKey of Object.keys(paths)) {
    if (!pathKey.startsWith('/api/v1/') || !paths[pathKey].post) continue;
    const slug = pathKey.replace('/api/v1/', '');
    lookup[slug] = pathKey;
    for (const suffix of STRIP_SUFFIXES) {
      if (slug.endsWith(suffix)) {
        const stripped = slug.slice(0, -suffix.length);
        if (!lookup[stripped]) lookup[stripped] = pathKey;
      }
    }
  }
  return lookup;
}

async function buildCatalog(log) {
  log = log || (() => {});
  log('Fetching live catalog...');
  const catRes = await fetch(CATALOG_URL);
  if (!catRes.ok) throw new Error(`Catalog fetch failed: ${catRes.status}`);
  const catalog = await catRes.json();

  log('Fetching OpenAPI spec for parameter schemas...');
  const specRes = await fetch(OPENAPI_URL);
  if (!specRes.ok) throw new Error(`OpenAPI fetch failed: ${specRes.status}`);
  const spec = await specRes.json();
  const schemas = (spec.components && spec.components.schemas) || {};
  const paths = spec.paths || {};
  const lookup = buildOpenAPILookup(paths);

  log(`Merging ${catalog.models.length} models with schemas...`);
  const models = [];
  let withParams = 0;

  for (const catModel of catalog.models) {
    const name = catModel.name;
    const openAPIPath = lookup[name] || null;
    const pathItem = openAPIPath ? paths[openAPIPath] : null;

    let schemaResult = null;
    if (pathItem) schemaResult = extractSchema(pathItem, schemas);

    const oapiTag = (pathItem && pathItem.post && pathItem.post.tags && pathItem.post.tags[0]) || '';
    const category = TAG_TO_CATEGORY[oapiTag] || inferGroupOf(catModel.group_of) || 'Other';
    const groupOf = catModel.group_of || inferGroupOf(category);

    const model = {
      id: name,
      name,
      description: ((pathItem && pathItem.post && pathItem.post.description) || catModel.description || '').substring(0, 500),
      category,
      family: catModel.family || null,
      group_of: groupOf,
      cost: catModel.cost || 0,
      cost_currency: catModel.cost_currency || 'USD',
      dynamic_pricing: !!catModel.dynamic_pricing,
      // Prefer the OpenAPI path (verified working endpoint); fall back to catalog
      endpoint: openAPIPath || catModel.endpoint,
      estimate_endpoint: catModel.estimate_endpoint || null,
      playground_url: `https://muapi.ai/playground/${name}`,
    };

    if (schemaResult && Object.keys(schemaResult.params).length > 0) {
      model.params = schemaResult.params;
      model.defaults = schemaResult.defaults;
      withParams++;
    }

    models.push(model);
  }

  models.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  return {
    synced_at: new Date().toISOString(),
    total: models.length,
    with_params: withParams,
    models,
  };
}

module.exports = { buildCatalog };

if (require.main === module) {
  buildCatalog((m) => console.log('  ' + m))
    .then((data) => {
      fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
      fs.writeFileSync(OUTPUT, JSON.stringify(data));
      console.log(`\nWrote ${data.total} models (${data.with_params} with param schemas) to ${OUTPUT}`);
      console.log(`Synced at: ${data.synced_at}`);
    })
    .catch((e) => {
      console.error('Fatal:', e.message);
      process.exit(1);
    });
}
