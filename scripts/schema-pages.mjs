import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';

function escapeMdxText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]#])/g, '\\$1');
}

function escapeMdxInlineCode(value) {
  return String(value).replace(/`/g, '&#96;').replace(/\|/g, '&#124;');
}

function titleCase(value) {
  return String(value).replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function documentSlug(file) {
  return slug(file.replaceAll('\\', '/').replace(/\.[^.]+$/, '').replaceAll('/', '-'));
}

function schemaRoute(document, component) {
  return `openapi/schemas/${documentSlug(document)}/${slug(component)}`;
}

function propertyType(schema) {
  if (schema.$ref) return schema.$ref.split('/').at(-1).replaceAll('~1', '/').replaceAll('~0', '~');
  if (schema.oneOf) return schema.oneOf.map(propertyType).join(' or ');
  if (schema.anyOf) return schema.anyOf.map(propertyType).join(' or ');
  if (schema.allOf) return schema.allOf.map(propertyType).join(' and ');
  if (schema.type === 'array') return `${propertyType(schema.items ?? {})}[]`;
  if (schema.type) return schema.format ? `${schema.type} (${schema.format})` : schema.type;
  return 'open JSON value';
}

function schemaReferences(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) schemaReferences(item, found);
  } else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') found.push(value.$ref);
    if (value.contentSchema && typeof value.contentSchema === 'object') schemaReferences(value.contentSchema, found);
    for (const [key, item] of Object.entries(value)) {
      if (!['$ref', 'contentSchema', 'example', 'examples', 'default', 'enum', 'const', 'x-example-evidence'].includes(key)) {
        schemaReferences(item, found);
      }
    }
  }
  return found;
}

function makeFrontmatter(title, description = '') {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

function typePageBody(sourceRoot, sourceFile, component, schema, urlFor) {
  const lines = [];
  if (schema.description) lines.push(escapeMdxText(schema.description.trim()), '');

  if (schema.oneOf || schema.anyOf || schema.allOf) {
    const variants = schema.oneOf ?? schema.anyOf ?? schema.allOf;
    const heading = schema.oneOf ? 'Variants' : schema.anyOf ? 'Accepted alternatives' : 'Composed schemas';
    lines.push(`## ${heading}`, '');
    for (const variant of variants) {
      if (variant.$ref) {
        const reference = localSchemaRef(variant.$ref, sourceFile);
        const name = reference?.name ?? variant.$ref.split('/').at(-1).replaceAll('~1', '/').replaceAll('~0', '~');
        const document = reference ? path.relative(sourceRoot, reference.file).replaceAll('\\', '/') : undefined;
        const target = document ? urlFor(document, name) : undefined;
        lines.push(target ? `- [${escapeMdxText(name)}](${target})` : `- ${escapeMdxText(name)}`);
      } else {
        lines.push(`- ${escapeMdxText(propertyType(variant))}`);
      }
    }
    lines.push('');
  }

  if (schema.properties && Object.keys(schema.properties).length) {
    const required = new Set(schema.required ?? []);
    lines.push('## Fields', '', '| Field | Type | Required |', '|---|---|---|');
    for (const [name, field] of Object.entries(schema.properties)) {
      const ref = field.$ref ?? field.contentSchema?.$ref;
      const reference = ref ? localSchemaRef(ref, sourceFile) : undefined;
      const targetName = reference?.name;
      const targetDocument = reference ? path.relative(sourceRoot, reference.file).replaceAll('\\', '/') : undefined;
      const type = targetName && targetDocument
        ? `[${escapeMdxText(targetName)}](${urlFor(targetDocument, targetName)})`
        : escapeMdxText(propertyType(field));
      const requiredValue = required.has(name) ? 'Yes' : 'No';
      const contentType = field.contentMediaType ? `; embedded content: ${field.contentMediaType}` : '';
      lines.push(`| \`${escapeMdxInlineCode(name)}\` | ${type}${escapeMdxText(contentType)} | ${requiredValue} |`);
      if (field.description) lines.push(`|  | ${escapeMdxText(field.description)} |  |`);
    }
    lines.push('');
  }

  const examples = [];
  if (Object.prototype.hasOwnProperty.call(schema, 'example')) examples.push(schema.example);
  if (Array.isArray(schema.examples)) examples.push(...schema.examples);
  if (examples.length) {
    lines.push('## Synthetic examples', '');
    for (const value of examples) {
      const sample = JSON.stringify(value, null, 2);
      const fence = '`'.repeat(Math.max(3, ...[...sample.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      lines.push(`${fence}json`, sample, fence, '');
    }
  }

  if (schema.additionalProperties === true || (schema.additionalProperties && typeof schema.additionalProperties === 'object')) {
    lines.push('Open fields are accepted by this schema.', '');
  }

  return `${makeFrontmatter(component, schema.description ?? `OpenAPI schema component ${component}.`)}# ${escapeMdxText(component)}\n\n${lines.join('\n')}`;
}

async function readDocument(sourceRoot, documentPath) {
  const absolute = path.resolve(sourceRoot, documentPath);
  const relative = path.relative(sourceRoot, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Schema document must be inside source-directory: ${documentPath}`);
  }
  const sourceRootRealPath = await realpath(sourceRoot);
  const absoluteRealPath = await realpath(absolute);
  const realRelative = path.relative(sourceRootRealPath, absoluteRealPath);
  if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Schema document resolves outside source-directory: ${documentPath}`);
  }
  const source = await readFile(absoluteRealPath, 'utf8');
  const parsed = /\.json$/i.test(documentPath) ? JSON.parse(source) : parseYaml(source);
  if (!parsed || typeof parsed !== 'object' || (!parsed.openapi && !parsed.asyncapi)) {
    throw new Error(`${documentPath} is not an OpenAPI or AsyncAPI document.`);
  }
  return { absolute: absoluteRealPath, document: parsed };
}

function localSchemaRef(ref, currentFile) {
  const [filePart, pointer = ''] = ref.split('#', 2);
  if (/^[a-z][a-z0-9+.-]*:/i.test(filePart)) throw new Error(`External schema reference is not allowed: ${ref}`);
  const file = filePart ? path.resolve(path.dirname(currentFile), filePart) : currentFile;
  if (!pointer.startsWith('/components/schemas/')) return undefined;
  const name = pointer.slice('/components/schemas/'.length).split('/')[0].replaceAll('~1', '/').replaceAll('~0', '~');
  return { file, name };
}

function parseBindings(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Schema bindings must be a YAML or JSON object.');
  const graphql = document.graphql ?? [];
  const openapi = document.openapi ?? [];
  const asyncapi = document.asyncapi ?? [];
  if (!Array.isArray(graphql) || !Array.isArray(openapi) || !Array.isArray(asyncapi)) {
    throw new Error('Schema bindings must contain graphql, openapi, and asyncapi arrays.');
  }
  return { graphql, openapi, asyncapi };
}

/**
 * Generate navigable OpenAPI component pages referenced by the schema bindings manifest.
 * Each referenced component and its nested named components get a page with schema fields and examples.
 */
export async function generateSchemaPages({ bindingsPath, sourceRoot, contentRoot }) {
  if (!bindingsPath) return { graphql: [], openapi: [], asyncapi: [], pages: [] };
  const bindingsSource = await readFile(bindingsPath, 'utf8');
  const bindingsDocument = /\.json$/i.test(bindingsPath) ? JSON.parse(bindingsSource) : parseYaml(bindingsSource);
  const bindings = parseBindings(bindingsDocument);
  const documents = new Map();
  const pageSchemas = new Map();

  async function loadComponent(reference) {
    if (!reference || typeof reference.document !== 'string' || typeof reference.component !== 'string') {
      throw new Error('Each schema binding requires document and component strings.');
    }
    const documentPath = path.posix.normalize(reference.document.replaceAll('\\', '/'));
    let loaded = documents.get(documentPath);
    if (!loaded) {
      loaded = await readDocument(sourceRoot, documentPath);
      documents.set(documentPath, loaded);
    }
    const schema = loaded.document.components?.schemas?.[reference.component];
    if (!schema) throw new Error(`${documentPath} does not define schema component ${reference.component}.`);
    const key = `${documentPath}#${reference.component}`;
    if (pageSchemas.has(key)) return key;
    pageSchemas.set(key, { document: documentPath, component: reference.component, schema, absolute: loaded.absolute });
    for (const ref of schemaReferences(schema)) {
      const resolved = localSchemaRef(ref, loaded.absolute);
      if (!resolved) continue;
      const refRelative = path.relative(sourceRoot, resolved.file).replaceAll('\\', '/');
      await loadComponent({ document: refRelative, component: resolved.name });
    }
    return key;
  }

  for (const binding of [...bindings.graphql, ...bindings.openapi, ...bindings.asyncapi]) {
    if (!binding || typeof binding !== 'object' || typeof binding.title !== 'string' || !Array.isArray(binding.schemas) || binding.schemas.length === 0) {
      throw new Error('Each GraphQL/OpenAPI/AsyncAPI binding requires title and a non-empty schemas array.');
    }
    for (const reference of binding.schemas) await loadComponent(reference);
  }

  const urls = new Map();
  for (const [key, item] of pageSchemas) urls.set(key, schemaRoute(item.document, item.component));
  const urlFor = (document, component) => {
    const target = urls.get(`${document}#${component}`);
    if (!target) throw new Error(`Referenced schema page was not generated: ${document}#${component}`);
    return target;
  };

  const root = path.join(contentRoot, 'openapi', 'schemas');
  const docPages = new Map();
  for (const [, item] of pageSchemas) {
    const docSlug = documentSlug(item.document);
    if (!docPages.has(docSlug)) docPages.set(docSlug, { document: item.document, pages: [] });
    const group = docPages.get(docSlug);
    group.pages.push(slug(item.component));
    const relativePath = path.join(docSlug, `${slug(item.component)}.mdx`);
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    const page = typePageBody(sourceRoot, item.absolute, item.component, item.schema, (source, component) => {
      const target = urlFor(source, component);
      const current = schemaRoute(item.document, item.component);
      return path.posix.relative(path.posix.dirname(current), target) || '.';
    });
    await writeFile(filePath, page, 'utf8');
  }

  const index = ['# Schema components', '', 'These pages are generated from named API schemas referenced by GraphQL, OpenAPI, and AsyncAPI bindings.', ''];
  for (const [docSlug, group] of [...docPages].sort(([a], [b]) => a.localeCompare(b))) {
    index.push(`## ${escapeMdxText(group.document)}`, '');
    for (const component of [...new Set(group.pages)].sort()) {
      const item = [...pageSchemas.values()].find((entry) => entry.document === group.document && slug(entry.component) === component);
      index.push(`- [${escapeMdxText(item.component)}](./schemas/${docSlug}/${component})`);
    }
    index.push('');
  }
  await writeFile(path.join(root, 'index.mdx'), `${makeFrontmatter('Schema components', 'Named API schema components linked to GraphQL and embedded payload fields.')}${index.join('\n')}\n`, 'utf8');
  await writeFile(path.join(root, 'meta.json'), JSON.stringify({ title: 'Schema components', pages: ['index', ...[...docPages.keys()].sort()] }, null, 2), 'utf8');
  for (const [docSlug, group] of docPages) {
    await writeFile(path.join(root, docSlug, 'meta.json'), JSON.stringify({ title: titleCase(group.document), pages: [...new Set(group.pages)].sort() }, null, 2), 'utf8');
  }

  const graphql = [];
  for (const binding of bindings.graphql) {
    if (typeof binding.type !== 'string' || typeof binding.field !== 'string') throw new Error('Each GraphQL binding requires type and field strings.');
    graphql.push({
      ...binding,
      targets: binding.schemas.map((reference) => ({
        label: reference.label ?? reference.component,
        url: urlFor(reference.document.replaceAll('\\', '/'), reference.component),
      })),
    });
  }
  const openapi = [];
  for (const binding of bindings.openapi) {
    if (typeof binding.document !== 'string' || typeof binding.path !== 'string' || typeof binding.method !== 'string') {
      throw new Error('Each OpenAPI binding requires document, path, and method strings.');
    }
    openapi.push({
      ...binding,
      document: path.resolve(sourceRoot, binding.document).replaceAll('\\', '/'),
      method: binding.method.toLowerCase(),
      targets: binding.schemas.map((reference) => ({
        label: reference.label ?? reference.component,
        url: urlFor(reference.document.replaceAll('\\', '/'), reference.component),
      })),
    });
  }

  const asyncapi = [];
  for (const binding of bindings.asyncapi) {
    if (typeof binding.document !== 'string' || typeof binding.operationId !== 'string') {
      throw new Error('Each AsyncAPI binding requires document and operationId strings.');
    }
    asyncapi.push({
      ...binding,
      document: path.resolve(sourceRoot, binding.document).replaceAll('\\', '/'),
      targets: binding.schemas.map((reference) => ({
        label: reference.label ?? reference.component,
        url: urlFor(reference.document.replaceAll('\\', '/'), reference.component),
      })),
    });
  }

  return { graphql, openapi, asyncapi, pages: [...pageSchemas.values()] };
}

export async function addSchemaPagesToOpenAPIMeta(contentRoot) {
  const openapiMetaPath = path.join(contentRoot, 'openapi', 'meta.json');
  try {
    const openapiMeta = JSON.parse(await readFile(openapiMetaPath, 'utf8'));
    openapiMeta.pages = [...new Set([...(openapiMeta.pages ?? []), 'schemas'])];
    await writeFile(openapiMetaPath, JSON.stringify(openapiMeta, null, 2), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await mkdir(path.dirname(openapiMetaPath), { recursive: true });
    await writeFile(openapiMetaPath, JSON.stringify({ title: 'OpenAPI', pages: ['schemas'] }, null, 2), 'utf8');
  }
}

function addOperationBindingLinks(files, bindings, routePrefix, operationMatches) {
  if (!bindings.length) return;
  for (const file of files) {
    if (!file.path.endsWith('.mdx')) continue;
    const documentMatch = file.content.match(/document="([^"]+)"/);
    const operationMatch = file.content.match(/operations=\{(\[[^\r\n]*\])\}/);
    if (!documentMatch || !operationMatch) continue;
    const operations = JSON.parse(operationMatch[1]);
    const documentPath = documentMatch[1].replaceAll('\\', '/');
    const matching = bindings.filter((binding) => binding.document === documentPath
      && operations.some((operation) => operationMatches(operation, binding)));
    if (!matching.length) continue;
    const generatedRoute = path.posix.join(routePrefix, file.path.replaceAll('\\', '/').replace(/\.mdx$/, ''));
    const currentRouteDirectory = path.posix.dirname(generatedRoute);
    const body = matching.map((binding) => {
      const links = binding.targets.map((target) => {
        const relativeUrl = path.posix.relative(currentRouteDirectory, target.url) || '.';
        return `<li><a href=${JSON.stringify(relativeUrl)}>${escapeMdxText(target.label)}</a></li>`;
      });
      const description = binding.description ? `${escapeMdxText(binding.description)}\n\n` : '';
      return `<section>\n<h2>${escapeMdxText(binding.title)}</h2>\n${description ? `<p>${description.trim()}</p>\n` : ''}<ul>\n${links.map((link) => `  ${link}`).join('\n')}\n</ul>\n</section>`;
    }).join('\n');
    const end = file.content.lastIndexOf('</>');
    if (end >= 0) {
      file.content = `${file.content.slice(0, end)}${body}\n${file.content.slice(end)}`;
    } else {
      file.content = `${file.content.trimEnd()}\n\n${body}\n`;
    }
  }
}

export function addOpenAPIBindingLinks(files, bindings) {
  addOperationBindingLinks(files, bindings, 'openapi', (operation, binding) =>
    operation.path === binding.path && operation.method === binding.method);
}

export function addAsyncAPIBindingLinks(files, bindings) {
  addOperationBindingLinks(files, bindings, 'asyncapi', (operation, binding) => operation.id === binding.operationId);
}
