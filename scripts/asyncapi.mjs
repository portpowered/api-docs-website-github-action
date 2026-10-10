import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const pointer = (value) => String(value).replaceAll('~', '~0').replaceAll('/', '~1');
const fallbackId = (direction, address) => `${direction}_${address.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'channel'}`;
const set = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });

/** Derive a renderer-compatible document; never mutate the canonical document. */
export function adaptAsyncAPI(document) {
  const source = structuredClone(document);
  if (/^3\./.test(source.asyncapi)) return source;
  if (!/^2\./.test(source.asyncapi)) throw new Error(`Unsupported AsyncAPI version: ${source.asyncapi}`);
  const result = { ...source, asyncapi: '3.0.0', channels: {}, operations: {} };
  const references = new Map();
  const resolve = (value) => {
    const visited = new Set();
    while (value?.$ref) {
      const reference = value.$ref;
      if (visited.has(reference)) throw new Error(`Circular AsyncAPI structural reference: ${reference}`);
      visited.add(reference);
      if (!reference.startsWith('#/')) throw new Error(`Cannot adapt external AsyncAPI 2 channel/operation reference: ${reference}`);
      const keys = reference.slice(2).split('/').map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
      value = keys.reduce((item, key) => item?.[key], source);
      if (!value) throw new Error(`Unresolved AsyncAPI reference: ${reference}`);
    }
    return value;
  };
  const security = (requirements) => requirements?.map((requirement) => {
    const names = Object.keys(requirement);
    if (names.length !== 1) throw new Error('AsyncAPI 2 security AND/anonymous requirements cannot be represented without changing semantics.');
    const name = names[0];
    if (!source.components?.securitySchemes?.[name]) throw new Error(`Unknown security scheme: ${name}`);
    if (requirement[name].length) throw new Error(`Scoped AsyncAPI 2 security requirement cannot be represented losslessly: ${name}`);
    return { $ref: `#/components/securitySchemes/${pointer(name)}` };
  });
  const parameter = (item) => {
    if (item.$ref) return item;
    const { schema, ...rest } = item;
    if (!schema) return rest;
    const converted = { ...rest, 'x-asyncapi2-schema': schema };
    for (const key of ['enum', 'default', 'examples']) if (schema[key] !== undefined) converted[key] = schema[key];
    if (schema.pattern) converted.description = `${rest.description || ''}\n\nPattern: \`${schema.pattern}\``.trim();
    return converted;
  };
  const message = (item) => {
    if (item.$ref) return item;
    const { schemaFormat, ...rest } = item;
    if (schemaFormat) {
      rest['x-asyncapi2-schema-format'] = schemaFormat;
      if (rest.payload !== undefined) rest.payload = { schemaFormat, schema: rest.payload };
    }
    if (rest.traits) rest.traits = rest.traits.map(message);
    return rest;
  };
  const trait = (item) => {
    if (item.$ref) return item;
    const { operationId, ...rest } = item;
    if (operationId) rest['x-asyncapi2-operation-id'] = operationId;
    if (rest.security) rest.security = security(rest.security);
    return rest;
  };
  for (const [name, original] of Object.entries(source.servers || {})) {
    if (original.$ref) continue;
    const { url, ...server } = original;
    if (!url) throw new Error(`Missing AsyncAPI 2 server URL: ${name}`);
    const match = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/]+)(\/.*)?$/i);
    if (!match) throw new Error(`Cannot adapt AsyncAPI server URL: ${url}`);
    server.host = match[1];
    if (match[2]) server.pathname = match[2];
    if (server.security) server.security = security(server.security);
    set(result.servers, name, server);
  }
  for (const [address, channelReference] of Object.entries(source.channels || {})) {
    const original = resolve(channelReference);
    const { publish, subscribe, servers, parameters, ...rest } = original;
    const channel = { ...rest, address, messages: {} };
    channel.servers = (servers || Object.keys(source.servers || {})).map((name) => ({ $ref: `#/servers/${pointer(name)}` }));
    if (parameters) channel.parameters = Object.fromEntries(Object.entries(parameters).map(([name, item]) => [name, parameter(item)]));
    set(result.channels, address, channel);
    for (const [direction, originalOperation] of Object.entries({ publish, subscribe })) {
      if (!originalOperation) continue;
      const operation = resolve(originalOperation);
      const { operationId, message: operationMessage, ...metadata } = operation;
      const id = operationId || fallbackId(direction, address);
      if (Object.hasOwn(result.operations, id)) throw new Error(`Duplicate AsyncAPI operation ID: ${id}`);
      const converted = { ...metadata, action: direction === 'publish' ? 'send' : 'receive', channel: { $ref: `#/channels/${pointer(address)}` }, messages: [] };
      references.set(`#/channels/${pointer(address)}/${direction}`, `#/operations/${pointer(id)}`);
      if (converted.security) converted.security = security(converted.security);
      if (converted.traits) converted.traits = converted.traits.map(trait);
      const variants = operationMessage?.oneOf || (operationMessage ? [operationMessage] : []);
      for (const [index, item] of variants.entries()) {
        const name = `${direction}_${index + 1}`;
        set(channel.messages, name, message(item));
        references.set(`#/channels/${pointer(address)}/${direction}/message${operationMessage?.oneOf ? `/oneOf/${index}` : ''}`, `#/channels/${pointer(address)}/messages/${name}`);
        converted.messages.push({ $ref: `#/channels/${pointer(address)}/messages/${name}` });
      }
      set(result.operations, id, converted);
    }
  }
  if (result.components?.messages) result.components.messages = Object.fromEntries(Object.entries(result.components.messages).map(([name, item]) => [name, message(item)]));
  if (result.components?.messageTraits) result.components.messageTraits = Object.fromEntries(Object.entries(result.components.messageTraits).map(([name, item]) => [name, message(item)]));
  if (result.components?.operationTraits) result.components.operationTraits = Object.fromEntries(Object.entries(result.components.operationTraits).map(([name, item]) => [name, trait(item)]));
  if (result.components?.parameters) result.components.parameters = Object.fromEntries(Object.entries(result.components.parameters).map(([name, item]) => [name, parameter(item)]));
  result['x-documentation-source-version'] = source.asyncapi;
  const rewriteReferences = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && references.has(child)) value[key] = references.get(child);
      else rewriteReferences(child);
    }
  };
  rewriteReferences(result);
  return result;
}

/** Keep non-JSON payloads as exact source documents, never invented JSON schemas. */
export async function prepareAsyncAPI(document, sourceFile) {
  const result = adaptAsyncAPI(document);
  const visit = async (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.schemaFormat && value.schema?.$ref && !/json|yaml/i.test(value.schemaFormat)) {
      const reference = value.schema.$ref;
      if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('#')) throw new Error(`Non-JSON schema source must be a local file: ${reference}`);
      if (reference.includes('#')) throw new Error(`Non-JSON schema source fragments are unsupported: ${reference}`);
      const text = await readFile(path.resolve(path.dirname(sourceFile), reference), 'utf8');
      value.schema = { 'x-documentation-source': { reference, format: value.schemaFormat, text } };
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === '$ref' && typeof child === 'string' && !child.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(child)) {
        const [file, fragment] = child.split('#');
        value[key] = `${path.resolve(path.dirname(sourceFile), file).replaceAll('\\', '/')}${fragment === undefined ? '' : `#${fragment}`}`;
      } else await visit(child);
    }
  };
  await visit(result);
  return result;
}

export async function writeAsyncAPIPresentations(files, directory) {
  await mkdir(directory, { recursive: true });
  const outputs = [];
  for (const [index, file] of files.entries()) {
    const raw = await readFile(file, 'utf8');
    const document = /\.json$/i.test(file) ? JSON.parse(raw) : parseYaml(raw);
    const output = path.join(directory, `${index}-${path.basename(file)}.json`);
    await writeFile(output, JSON.stringify(await prepareAsyncAPI(document, file), null, 2));
    outputs.push(output.replaceAll('\\', '/'));
  }
  return outputs;
}
