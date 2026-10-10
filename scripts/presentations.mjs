import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { prepareAsyncAPI } from './asyncapi.mjs';

// These maps contain user-defined names, including legitimate names starting x-.
const dictionaries = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'schemas',
  'paths', 'channels', 'messages', 'operations', 'servers', 'securitySchemes', 'parameters',
  'responses', 'headers', 'requestBodies', 'examples', 'links', 'callbacks', 'webhooks',
  'serverVariables', 'replies', 'replyAddresses', 'correlationIds', 'operationTraits',
  'messageTraits', 'tags', 'externalDocs', 'serverBindings', 'channelBindings',
  'operationBindings', 'messageBindings']);
const dictionaryValue = (key, value) => dictionaries.has(key)
  && !(key === 'externalDocs' && typeof value?.url === 'string')
  && !(key === 'headers' && (typeof value?.type === 'string' || value?.schemaFormat || value?.properties));

/** Copy a local reference graph for presentation, leaving canonical contracts intact. */
export async function writeSchemaPresentations(schemas, directory) {
  await mkdir(directory, { recursive: true });
  const outputs = new Map();
  const copy = async (sourceFile) => {
    sourceFile = path.resolve(sourceFile);
    if (outputs.has(sourceFile)) return outputs.get(sourceFile);
    const output = path.join(directory, `${outputs.size}-${path.basename(sourceFile)}.json`);
    // Reserve before following references so mutually recursive documents keep their graph.
    outputs.set(sourceFile, output);
    const raw = await readFile(sourceFile, 'utf8');
    let document = /\.json$/i.test(sourceFile) ? JSON.parse(raw) : parseYaml(raw);
    if (!document || typeof document !== 'object') throw new Error(`Referenced schema is not a structured document: ${sourceFile}`);
    if (document.asyncapi) document = await prepareAsyncAPI(document, sourceFile, { rebaseReferences: false });
    const visit = async (value, extension = false, dictionary = false) => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value) await visit(item, extension);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' && typeof child === 'string') {
          if (extension) {
            if (Object.hasOwn(value, 'x-documentation-reference')) throw new Error('Vendor extension already defines x-documentation-reference alongside $ref.');
            value['x-documentation-reference'] = child;
            delete value.$ref;
          } else if (!child.startsWith('#')) {
            const separator = child.indexOf('#');
            const file = separator === -1 ? child : child.slice(0, separator);
            const fragment = separator === -1 ? '' : child.slice(separator);
            if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !path.win32.isAbsolute(file) && !file.startsWith('file:')) continue;
            const target = file.startsWith('file:') ? fileURLToPath(file) : path.resolve(path.dirname(sourceFile), decodeURIComponent(file));
            const copied = await copy(target);
            value.$ref = `${copied.replaceAll('\\', '/')}${fragment}`;
          }
        } else {
          await visit(child, extension || (!dictionary && key.startsWith('x-')), dictionaryValue(key, child));
        }
      }
    };
    await visit(document);
    await writeFile(output, JSON.stringify(document, null, 2));
    return output;
  };
  const prepared = { ...schemas };
  for (const kind of ['openapi', 'asyncapi']) {
    prepared[kind] = [];
    for (const file of schemas[kind] || []) prepared[kind].push((await copy(file)).replaceAll('\\', '/'));
  }
  return prepared;
}
