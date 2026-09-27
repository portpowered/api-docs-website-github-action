import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { parse as parseGraphQL, Kind } from 'graphql';

const sourceRoot = path.resolve(process.env.API_DOCS_SOURCE || '.');
const outputRoot = path.resolve(process.env.API_DOCS_OUTPUT || 'api-docs-out');
const title = process.env.API_DOCS_TITLE?.trim() || 'API Documentation';
const discover = (process.env.API_DOCS_DISCOVER || 'true').toLowerCase() !== 'false';

function html(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function patterns(name) {
  return (process.env[`API_DOCS_${name}`] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function matches(explicit, extensions) {
  const found = new Set();
  for (const pattern of explicit) {
    const paths = await fg(pattern, { cwd: sourceRoot, onlyFiles: true, unique: true, followSymbolicLinks: false });
    if (paths.length === 0) throw new Error(`Schema path or pattern did not match any files: ${pattern}`);
    for (const file of paths) found.add(file);
  }
  if (discover && explicit.length === 0) {
    for (const file of await fg(`**/*.{${extensions.join(',')}}`, {
      cwd: sourceRoot,
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
    })) found.add(file);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

async function textFile(file) {
  return readFile(path.resolve(sourceRoot, file), 'utf8');
}

async function structuredFile(file) {
  const content = await textFile(file);
  const data = /\.json$/i.test(file) ? JSON.parse(content) : parseYaml(content);
  if (!data || typeof data !== 'object') throw new Error(`${file} does not contain a YAML or JSON object`);
  return { content, data };
}

function resolveRef(value, root) {
  let current = value;
  for (let depth = 0; depth < 8 && current?.$ref?.startsWith('#/'); depth += 1) {
    const parts = current.$ref.slice(2).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    let target = root;
    for (const part of parts) target = target?.[part];
    if (!target || target === current) break;
    current = target;
  }
  return current;
}

function idPrefix(file) {
  return path.basename(file).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
}

function schemaRows(schema, root) {
  schema = resolveRef(schema, root);
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return '<p class="muted">No properties defined.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Property</th><th>Type</th><th>Description</th></tr></thead><tbody>${Object.entries(properties).map(([name, rawProperty]) => { const property = resolveRef(rawProperty, root); return `<tr><td><code>${html(name)}${schema.required?.includes(name) ? ' <span class="required">required</span>' : ''}</code></td><td>${html(property?.type || rawProperty?.$ref || 'object')}${property?.format ? ` · ${html(property.format)}` : ''}</td><td>${html(property?.description || '')}</td></tr>`; }).join('')}</tbody></table></div>`;
}

function openApiSections(document, file) {
  const info = document.info || {};
  const content = [];
  const paths = document.paths || {};
  for (const [route, pathItem] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (!['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'].includes(method.toLowerCase())) continue;
      const id = `${idPrefix(file)}-http-${content.length + 1}`;
      const params = (operation.parameters || []).map((p) => resolveRef(p, document)).map((p) => `<li><code>${html(p.name)}</code> <span class="muted">${html(p.in)}${p.required ? ', required' : ''}</span>${p.description ? ` — ${html(p.description)}` : ''}</li>`).join('');
      const requestBody = resolveRef(operation.requestBody, document);
      const requestSchema = requestBody?.content && Object.values(requestBody.content)[0]?.schema;
      const responses = Object.entries(operation.responses || {}).map(([status, raw]) => { const response = resolveRef(raw, document); return `<li><code>${html(status)}</code> ${html(response?.description || '')}</li>`; }).join('');
      content.push({ id, label: `${method.toUpperCase()} ${route}`, type: 'HTTP operation', html: `<article class="doc-card"><div class="eyebrow">${html((operation.tags || ['HTTP API']).join(' · '))}</div><h2><span class="method method-${method.toLowerCase()}">${html(method.toUpperCase())}</span> <code>${html(route)}</code></h2><p class="lead">${html(operation.summary || operation.description || '')}</p>${operation.description && operation.summary ? `<p>${html(operation.description)}</p>` : ''}${params ? `<h3>Parameters</h3><ul>${params}</ul>` : ''}${requestSchema ? `<h3>Request body</h3>${schemaRows(requestSchema, document)}` : ''}${responses ? `<h3>Responses</h3><ul>${responses}</ul>` : ''}<p class="source">Source: <code>${html(file)}</code> · operationId <code>${html(operation.operationId || 'not specified')}</code></p></article>` });
    }
  }
  for (const [name, schema] of Object.entries(document.components?.schemas || {})) {
    const id = `${idPrefix(file)}-http-schema-${content.length + 1}`;
    content.push({ id, label: name, type: 'HTTP schema', html: `<article class="doc-card"><div class="eyebrow">${html(schema.type || 'schema')}</div><h2>${html(name)}</h2><p>${html(schema.description || '')}</p>${schemaRows(schema, document)}<p class="source">Source: <code>${html(file)}</code></p></article>` });
  }
  return { name: info.title || path.basename(file), kind: 'OpenAPI', description: info.description || '', version: info.version || '', sections: content };
}

function asyncApiSections(document, file) {
  const info = document.info || {};
  const sections = [];
  const addOperation = (verb, channel, operation, rawMessage, operationName = '') => {
    const message = resolveRef(rawMessage, document) || {};
    const schema = resolveRef(message.payload, document);
    const id = `${idPrefix(file)}-event-${sections.length + 1}`;
    sections.push({ id, label: `${verb} ${channel}`, type: 'Event operation', html: `<article class="doc-card"><div class="eyebrow">${html((operation.tags || []).map((t) => t.name || t).join(' · ') || 'Event API')}</div><h2><span class="method method-${verb}">${html(verb)}</span> <code>${html(channel)}</code></h2>${operationName ? `<p>Operation: <code>${html(operationName)}</code></p>` : ''}<p class="lead">${html(operation.summary || operation.description || message.summary || '')}</p>${message.name ? `<p>Message: <code>${html(message.name)}</code></p>` : ''}${schema ? `<h3>Payload</h3>${schemaRows(schema, document)}` : ''}<p class="source">Source: <code>${html(file)}</code></p></article>` });
  };
  for (const [channel, item] of Object.entries(document.channels || {})) {
    for (const [verb, operation] of Object.entries(item || {})) {
      if (!['publish', 'subscribe'].includes(verb)) continue;
      const messages = operation.message?.oneOf || [operation.message].filter(Boolean);
      for (const message of messages) addOperation(verb, item.address || channel, operation, message);
    }
  }
  for (const [operationName, rawOperation] of Object.entries(document.operations || {})) {
    const operation = resolveRef(rawOperation, document) || {};
    const action = operation.action === 'send' ? 'publish' : operation.action === 'receive' ? 'subscribe' : operation.action;
    if (!['publish', 'subscribe'].includes(action)) continue;
    const channelRef = operation.channel?.$ref || '';
    const channelKey = channelRef.startsWith('#/channels/') ? channelRef.slice('#/channels/'.length).replaceAll('~1', '/').replaceAll('~0', '~') : '';
    const channel = resolveRef(operation.channel, document) || document.channels?.[channelKey] || {};
    const address = channel.address || channelKey || operationName;
    const messages = operation.messages?.length
      ? operation.messages.map((message) => resolveRef(message, document))
      : Object.values(channel.messages || {}).map((message) => resolveRef(message, document));
    for (const message of messages) addOperation(action, address, operation, message, operationName);
  }
  return { name: info.title || path.basename(file), kind: 'AsyncAPI', description: info.description || '', version: info.version || '', sections };
}

function graphqlSections(source, file) {
  const document = parseGraphQL(source);
  const sections = document.definitions.filter((d) => d.name && d.kind !== Kind.SCHEMA_DEFINITION).map((definition, index) => {
    const id = `${idPrefix(file)}-graphql-${index + 1}`;
    const kind = definition.kind.replace('_DEFINITION', '').toLowerCase();
    const fields = definition.fields || definition.values || [];
    const fieldList = fields.length ? `<div class="table-wrap"><table><thead><tr><th>Field</th><th>Type / Arguments</th><th>Description</th></tr></thead><tbody>${fields.map((field) => `<tr><td><code>${html(field.name.value)}</code></td><td><code>${html(field.type ? printType(field.type) : '')}${field.arguments?.length ? `(${field.arguments.map((arg) => `${arg.name.value}: ${printType(arg.type)}`).join(', ')})` : ''}</code></td><td>${html(field.description?.value || '')}</td></tr>`).join('')}</tbody></table></div>` : '';
    const description = definition.description?.value || '';
    return { id, label: definition.name.value, type: `GraphQL ${kind}`, html: `<article class="doc-card"><div class="eyebrow">${html(kind)}</div><h2>${html(definition.name.value)}</h2>${description ? `<p class="lead">${html(description)}</p>` : ''}${fieldList}<details><summary>View SDL</summary><pre><code>${html(sourceForNode(source, definition))}</code></pre></details><p class="source">Source: <code>${html(file)}</code></p></article>` };
  });
  return { name: path.basename(file), kind: 'GraphQL', description: 'GraphQL schema definitions', version: '', sections };
}

function printType(node) {
  if (node.kind === Kind.NAMED_TYPE) return node.name.value;
  if (node.kind === Kind.LIST_TYPE) return `[${printType(node.type)}]`;
  if (node.kind === Kind.NON_NULL_TYPE) return `${printType(node.type)}!`;
  return '';
}

function sourceForNode(source, node) {
  return node.loc ? source.slice(node.loc.start, node.loc.end) : '';
}

const documents = [];
const used = new Set();
const openapiFiles = await matches(patterns('OPENAPI'), ['yaml', 'yml', 'json']);
const asyncapiFiles = await matches(patterns('ASYNCAPI'), ['yaml', 'yml', 'json']);
const graphqlFiles = await matches(patterns('GRAPHQL'), ['graphql', 'gql']);

for (const file of openapiFiles) {
  const parsed = await structuredFile(file);
  if (patterns('OPENAPI').length && !parsed.data.openapi) throw new Error(`${file} is not an OpenAPI document`);
  if (!parsed.data.openapi) continue;
  documents.push(openApiSections(parsed.data, file)); used.add(file);
}
for (const file of asyncapiFiles) {
  const parsed = await structuredFile(file);
  if (patterns('ASYNCAPI').length && !parsed.data.asyncapi) throw new Error(`${file} is not an AsyncAPI document`);
  if (!parsed.data.asyncapi) continue;
  documents.push(asyncApiSections(parsed.data, file)); used.add(file);
}
for (const file of graphqlFiles) {
  documents.push(graphqlSections(await textFile(file), file)); used.add(file);
}

if (discover) {
  const candidates = await fg('**/*.{yaml,yml,json,graphql,gql}', { cwd: sourceRoot, onlyFiles: true, unique: true, followSymbolicLinks: false, ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'] });
  for (const file of candidates) {
    if (used.has(file)) continue;
    try {
      if (/\.(graphql|gql)$/i.test(file)) {
        const source = await textFile(file);
        if (/\b(type|schema|scalar|enum|input|interface|union|directive)\b/.test(source)) {
          documents.push(graphqlSections(source, file)); used.add(file);
        }
        continue;
      }
      const parsed = await structuredFile(file);
      if (parsed.data.openapi) { documents.push(openApiSections(parsed.data, file)); used.add(file); }
      else if (parsed.data.asyncapi) { documents.push(asyncApiSections(parsed.data, file)); used.add(file); }
    } catch {
      // Discovery scans ordinary repository YAML too; unrelated files are ignored.
    }
  }
}

if (documents.length === 0) throw new Error('No supported API schemas found. Set openapi, asyncapi, or graphql paths, or enable discover.');
const sourceFromOutput = path.relative(outputRoot, sourceRoot);
if (!sourceFromOutput || (!sourceFromOutput.startsWith(`..${path.sep}`) && sourceFromOutput !== '..' && !path.isAbsolute(sourceFromOutput))) {
  throw new Error('The output directory cannot be the source directory or one of its parent directories.');
}

const nav = documents.map((doc, index) => `<a class="nav-group" href="#api-${index}"><span class="nav-kind">${html(doc.kind)}</span>${html(doc.name)}</a>${doc.sections.map((section) => `<a class="nav-item" href="#doc-${index}-${html(section.id)}">${html(section.label)}</a>`).join('')}`).join('');
const sections = documents.map((doc, index) => `<section class="api-section" id="api-${index}"><header class="api-header"><div class="eyebrow">${html(doc.kind)}${doc.version ? ` · v${html(doc.version)}` : ''}</div><h2>${html(doc.name)}</h2>${doc.description ? `<p>${html(doc.description)}</p>` : ''}</header>${doc.sections.length ? doc.sections.map((section) => `<div id="doc-${index}-${html(section.id)}">${section.html}</div>`).join('') : '<p class="empty">No operations or definitions found in this document.</p>'}</section>`).join('');
const capabilities = [...new Set(documents.map((doc) => ({ OpenAPI: 'HTTP operations and schemas', AsyncAPI: 'event channels and messages', GraphQL: 'GraphQL definitions' })[doc.kind] || 'API schemas'))];
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="API reference for ${html(title)}"><title>${html(title)}</title><style>
:root{color-scheme:light;--ink:#17211d;--muted:#64716b;--line:#e1e8e3;--paper:#fff;--wash:#f5f8f6;--green:#087e61;--green-wash:#e4f4ee;--mono:ui-monospace,SFMono-Regular,Consolas,monospace}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{display:grid;grid-template-columns:280px minmax(0,900px);justify-content:center;min-height:100vh}.sidebar{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line);padding:30px 20px;background:#fbfcfb}.brand{font-size:17px;font-weight:750;line-height:1.3;margin:0 0 8px}.tagline{color:var(--muted);font-size:12px;margin:0 0 25px}.search{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:white;font:inherit;margin-bottom:20px}.nav-group,.nav-item{display:block;text-decoration:none;color:var(--ink);padding:7px 9px;border-radius:6px;overflow-wrap:anywhere}.nav-group{font-weight:650;margin-top:12px}.nav-group:hover,.nav-item:hover{background:var(--green-wash);color:var(--green)}.nav-kind,.eyebrow{display:block;color:var(--green);font-size:10px;font-weight:750;letter-spacing:.1em;text-transform:uppercase}.nav-item{padding:4px 9px 4px 17px;color:#66716b;font-size:13px}.main{width:min(100%,980px);min-width:0;padding:55px 64px 100px}.hero{padding:0 0 34px;border-bottom:1px solid var(--line);margin-bottom:38px}.hero h1{font-size:38px;line-height:1.15;letter-spacing:-.035em;margin:8px 0 12px}.hero p{color:var(--muted);max-width:650px}.count{display:inline-flex;align-items:center;background:var(--green-wash);color:var(--green);padding:5px 10px;border-radius:99px;font-size:12px;font-weight:650}.api-section{margin:0 0 56px}.api-header{margin-bottom:20px}.api-header h2{font-size:27px;margin:4px 0}.api-header p{margin:4px 0;color:var(--muted)}.doc-card{border:1px solid var(--line);border-radius:11px;padding:23px 25px;margin:15px 0 22px;box-shadow:0 2px 8px #122a1910}.doc-card h2{font-size:20px;margin:5px 0 10px;line-height:1.45}.doc-card h3{font-size:14px;margin:23px 0 7px}.doc-card p{margin:8px 0}.lead{font-size:15px;font-weight:550}.muted,.source{color:var(--muted);font-size:12px}.source{margin-top:19px!important}.method{display:inline-block;vertical-align:2px;padding:2px 7px;border-radius:5px;background:var(--green-wash);color:var(--green);font:700 11px var(--mono)}.method-post,.method-publish{background:#e9edff;color:#4a5cb4}.method-delete{background:#fff0ed;color:#b54731}.method-put,.method-patch,.method-subscribe{background:#fff6df;color:#8a6513}.doc-card code,.api-header code{font-family:var(--mono);font-size:.9em}.required{color:#b54731;font:10px sans-serif}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em}ul{padding-left:20px}li{margin:5px 0}details{margin:18px 0}summary{cursor:pointer;color:var(--green);font-weight:600}pre{overflow:auto;padding:14px;border-radius:8px;background:#f3f6f4;font:12px/1.6 var(--mono)}.empty{padding:25px;background:var(--wash);color:var(--muted);border-radius:10px}.footer{border-top:1px solid var(--line);padding-top:18px;color:var(--muted);font-size:12px}@media(max-width:800px){.shell{display:block}.sidebar{position:relative;height:auto;max-height:44vh;border-right:0;border-bottom:1px solid var(--line)}.main{padding:35px 22px 70px}.hero h1{font-size:30px}}
</style></head><body><div class="shell"><aside class="sidebar"><p class="brand">${html(title)}</p><p class="tagline">API reference</p><input class="search" type="search" placeholder="Filter navigation…" aria-label="Filter navigation" oninput="filterNav(this.value)"><nav id="navigation">${nav}</nav></aside><main class="main"><header class="hero"><span class="eyebrow">Developer reference</span><h1>${html(title)}</h1><p>Explore ${html(capabilities.join(', '))} documented by this library.</p><span class="count">${documents.length} schema${documents.length === 1 ? '' : 's'} · ${documents.reduce((n, doc) => n + doc.sections.length, 0)} entries</span></header>${sections}<footer class="footer">Generated from the API schema files in this repository.</footer></main></div><script>function filterNav(query){const q=query.toLowerCase();document.querySelectorAll('#navigation a').forEach(a=>a.hidden=!a.textContent.toLowerCase().includes(q))}</script></body></html>`;

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'index.html'), page, 'utf8');
console.log(`Generated API documentation for ${documents.length} schema(s) in ${outputRoot}`);
