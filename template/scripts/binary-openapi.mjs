import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
}

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]#])/g, '\\$1');
}

function parseSource(source, file) {
  return /\.json$/i.test(file) ? JSON.parse(source) : parseYaml(source);
}

function contentHasProtobuf(content) {
  return Boolean(content && Object.hasOwn(content, 'application/x-protobuf'));
}

function operationHasProtobuf(operation) {
  if (contentHasProtobuf(operation?.requestBody?.content)) return true;
  return Object.values(operation?.responses ?? {}).some((response) => contentHasProtobuf(response?.content));
}

function anchorExternalFileReferences(value, sourceFile) {
  if (Array.isArray(value)) {
    for (const item of value) anchorExternalFileReferences(item, sourceFile);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, item] of Object.entries(value)) {
    if (key === '$ref' && typeof item === 'string') {
      const hash = item.indexOf('#');
      const filePart = hash < 0 ? item : item.slice(0, hash);
      if (filePart && !/^[a-z][a-z0-9+.-]*:/i.test(filePart) && !filePart.startsWith('//')) {
        value[key] = `${path.resolve(path.dirname(sourceFile), filePart).replaceAll('\\', '/')}${hash < 0 ? '' : item.slice(hash)}`;
      }
    } else {
      anchorExternalFileReferences(item, sourceFile);
    }
  }
}

function schemaReferences(documentPath, sourceRoot, operation) {
  const found = new Map();
  const collect = (content) => {
    const schema = content?.['application/x-protobuf']?.schema;
    const ref = schema?.$ref;
    if (typeof ref !== 'string') return;
    const [filePart, pointer = ''] = ref.split('#', 2);
    if (!pointer.startsWith('/components/schemas/')) return;
    const file = filePart ? path.resolve(path.dirname(documentPath), filePart) : documentPath;
    const component = pointer.slice('/components/schemas/'.length).split('/')[0]
      .replaceAll('~1', '/').replaceAll('~0', '~');
    const document = path.relative(sourceRoot, file).replaceAll('\\', '/');
    const key = `${document}#${component}`;
    found.set(key, { document, component, label: component });
  };

  collect(operation.requestBody?.content);
  for (const response of Object.values(operation.responses ?? {})) collect(response?.content);
  return [...found.values()];
}

/**
 * Remove operations using application/x-protobuf from the input passed to Fumadocs.
 * The source document is left intact and the removed operations are rendered as static pages.
 */
export async function inspectBinaryOpenAPIDocuments(sourceDocuments, sourceRoot) {
  const nativeInputs = {};
  const operations = [];
  const bindings = [];

  for (const sourceDocument of sourceDocuments) {
    const absolute = path.resolve(sourceDocument);
    const source = await readFile(absolute, 'utf8');
    const document = parseSource(source, absolute);
    if (!document?.openapi || !document.paths) {
      nativeInputs[absolute.replaceAll('\\', '/')] = absolute.replaceAll('\\', '/');
      continue;
    }

    const nativeDocument = structuredClone(document);
    let removed = false;
    for (const [route, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!methods.has(method.toLowerCase()) || !operationHasProtobuf(operation)) continue;
        removed = true;
        const references = schemaReferences(absolute, sourceRoot, operation);
        const fallback = {
          document: absolute.replaceAll('\\', '/'),
          documentPath: path.relative(sourceRoot, absolute).replaceAll('\\', '/'),
          openapi: document,
          route,
          method: method.toLowerCase(),
          operation,
          pathItem,
          schemas: references,
        };
        operations.push(fallback);
        if (references.length) {
          bindings.push({
            document: fallback.documentPath,
            path: route,
            method: method.toLowerCase(),
            title: 'Binary protobuf wire schemas',
            description: 'The protobuf payloads are documented as binary schemas; no example bytes are specified.',
            schemas: references,
          });
        }
        delete nativeDocument.paths[route][method];
      }

      if (!Object.keys(nativeDocument.paths[route] ?? {}).some((key) => methods.has(key.toLowerCase()))) {
        delete nativeDocument.paths[route];
      }
    }

    const hasNativeOperations = Object.values(nativeDocument.paths ?? {}).some((pathItem) =>
      Object.keys(pathItem ?? {}).some((key) => methods.has(key.toLowerCase())));
    if (!removed) nativeInputs[absolute.replaceAll('\\', '/')] = absolute.replaceAll('\\', '/');
    else if (hasNativeOperations) {
      anchorExternalFileReferences(nativeDocument, absolute);
      nativeInputs[absolute.replaceAll('\\', '/')] = nativeDocument;
    }
  }

  return { nativeInputs, operations, bindings };
}

function tagRouteSegments(document, operation) {
  const tags = new Map((document.tags ?? []).filter((tag) => tag?.name).map((tag) => [tag.name, tag]));
  const names = (operation.tags ?? []).filter((name) => tags.get(name)?.kind !== 'nav');
  const selected = names.length ? names : ['unknown'];
  return [...new Set(selected)].map((name) => {
    const segments = [];
    const visited = new Set();
    let current = name;
    while (current && !visited.has(current)) {
      visited.add(current);
      segments.unshift(slug(current));
      current = tags.get(current)?.parent;
    }
    return segments;
  });
}

function operationSlug(operation, route, method) {
  const preferred = operation.operationId || `${slug(route)}-${method}`;
  return String(preferred).replace(/[\\/]/g, '-').replace(/\.\.+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'operation';
}

function schemaName(schema) {
  if (typeof schema?.$ref !== 'string') return undefined;
  return schema.$ref.split('/').at(-1).replaceAll('~1', '/').replaceAll('~0', '~');
}

function mediaRows(content, route, binding, document) {
  if (!content || typeof content !== 'object') return ['No media types are declared.'];
  const lines = [];
  const references = new Map((binding?.targets ?? []).map((target) => [target.label, target]));
  for (const [mediaType, media] of Object.entries(content)) {
    lines.push(`- Content type: \`${escapeText(mediaType)}\``);
    const component = schemaName(media?.schema);
    if (component) {
      const target = references.get(component);
      const targetSchema = document.components?.schemas?.[component];
      const schemaDetails = [
        targetSchema?.type && `type: ${targetSchema.type}`,
        targetSchema?.format && `format: ${targetSchema.format}`,
      ].filter(Boolean).join('; ');
      if (target) {
        const relative = path.posix.relative(route, target.url) || '.';
        lines.push(`  - Schema: [${escapeText(component)}](${relative})${schemaDetails ? ` (${escapeText(schemaDetails)})` : ''}`);
      } else {
        lines.push(`  - Schema: \`${escapeText(component)}\`${schemaDetails ? ` (${escapeText(schemaDetails)})` : ''}`);
      }
    } else if (media?.schema) {
      const type = media.schema.type ? `type: ${media.schema.type}` : undefined;
      const format = media.schema.format ? `format: ${media.schema.format}` : undefined;
      const detail = [type, format].filter(Boolean).join('; ');
      if (detail) lines.push(`  - Schema: ${escapeText(detail)}`);
    }
  }
  return lines;
}

function frontmatter(title, description) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

async function appendMetaPage(filePath, page) {
  let meta = { title: 'OpenAPI', pages: [] };
  try {
    meta = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    const entries = await readdir(path.dirname(filePath), { withFileTypes: true });
    meta.pages = entries.flatMap((entry) => {
      if (entry.isDirectory()) return [entry.name];
      if (entry.isFile() && entry.name.endsWith('.mdx')) return [entry.name.slice(0, -'.mdx'.length)];
      return [];
    });
  }
  meta.pages = [...new Set([...(meta.pages ?? []), page])];
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(meta, null, 2), 'utf8');
}

async function addRouteToMeta(openapiRoot, segments, page) {
  for (let depth = 0; depth < segments.length; depth++) {
    const directory = path.join(openapiRoot, ...segments.slice(0, depth));
    await appendMetaPage(path.join(directory, 'meta.json'), segments[depth]);
  }
  await appendMetaPage(path.join(openapiRoot, ...segments, 'meta.json'), page);
}

/** Render the unsupported media operations without serializing or fabricating payload bytes. */
export async function writeBinaryOpenAPIFallbacks(contentRoot, operations, bindings) {
  if (!operations.length) return;
  const openapiRoot = path.join(contentRoot, 'openapi');
  for (const fallback of operations) {
    const binding = bindings.find((candidate) => candidate.document === fallback.document
      && candidate.path === fallback.route && candidate.method === fallback.method);
    const { operation, openapi, route: apiRoute, method, pathItem } = fallback;
    const pageName = operationSlug(operation, apiRoute, method);
    const description = operation.description ?? operation.summary ?? `Binary protobuf operation for ${apiRoute}.`;
    const tagRoutes = tagRouteSegments(openapi, operation);
    for (const groupSegments of tagRoutes) {
      const pageRoute = [...groupSegments, pageName];
      const route = path.posix.join('openapi', ...pageRoute);
      const lines = [
        `# ${escapeText(operation.summary || operation.operationId || pageName)}`,
        '',
        `**Operation ID:** \`${escapeText(operation.operationId || pageName)}\``,
        '',
        `**Request:** \`${method.toUpperCase()} ${escapeText(apiRoute)}\``,
        '',
      ];

      const servers = operation.servers ?? pathItem.servers ?? openapi.servers ?? [];
      if (servers.length) {
        lines.push('## Servers', '');
        for (const server of servers) lines.push(`- [${escapeText(server.url)}](${server.url})`);
        lines.push('');
      }

      const requestBody = operation.requestBody;
      if (requestBody) {
        lines.push('## Request body', '');
        if (requestBody.required) lines.push('Required.', '');
        lines.push(...mediaRows(requestBody.content, route, binding, openapi), '');
      }

      lines.push('## Responses', '');
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        lines.push(`### ${escapeText(status)}`, '');
        if (response.description) lines.push(`${escapeText(response.description)}`, '');
        lines.push(...mediaRows(response.content, route, binding, openapi), '');
      }

      const pagePath = path.join(openapiRoot, ...pageRoute.slice(0, -1), `${pageName}.mdx`);
      await mkdir(path.dirname(pagePath), { recursive: true });
      await writeFile(pagePath, `${frontmatter(operation.summary || operation.operationId || pageName, description)}${lines.join('\n')}\n`, 'utf8');
      await addRouteToMeta(openapiRoot, groupSegments, pageName);
    }
  }
}
