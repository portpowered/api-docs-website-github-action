import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createAsyncAPI } from '@fumadocs/asyncapi/server';
import { adaptAsyncAPI, prepareAsyncAPI, writeAsyncAPIPresentations } from '../scripts/asyncapi.mjs';

const v2 = parseYaml(await readFile(new URL('./fixtures/asyncapi.yaml', import.meta.url), 'utf8'));
const snapshot = structuredClone(v2);
const adapted = adaptAsyncAPI(v2);
assert.deepEqual(v2, snapshot, 'The canonical document must not change.');
assert.equal(adapted.asyncapi, '3.0.0');
assert.equal(adapted.operations.publishWidgetCreated.action, 'send');
assert.deepEqual(adapted.channels['widgets/created'].messages.publish_1.payload, v2.channels['widgets/created'].publish.message.payload);
const v3 = parseYaml(await readFile(new URL('./fixtures/asyncapi3.yaml', import.meta.url), 'utf8'));
assert.deepEqual(adaptAsyncAPI(v3), v3, 'Valid v3 documents and references retain their structure.');

const complex = {
  asyncapi: '2.6.0', info: { title: 'Synthetic bridge', version: '1' },
  servers: {
    production: { url: 'websocket.example.invalid', protocol: 'wss' },
    sandbox: { url: 'sandbox.example.invalid', protocol: 'wss' },
    bootstrap: { url: '{host}', protocol: 'wss', variables: { host: { default: 'websocket.example.invalid' } }, 'x-host-schema': { $ref: './models.yaml#/Host' } },
  },
  channels: {
    '/v2/{connection}': {
      parameters: { connection: { description: 'Hex connection', schema: { type: 'string', pattern: '^[0-9a-f]+$' } } },
      'x-framing-schema': { $ref: './models.yaml#/Frame' }, 'x-upgrade-operation': { $ref: './models.yaml#/Upgrade' },
      publish: { summary: 'Send', traits: [{ $ref: '#/components/operationTraits/trace' }], message: { oneOf: [{ $ref: '#/components/messages/Client' }, { name: 'Alternative', payload: { type: 'integer' } }] } },
      subscribe: { message: { name: 'Server', contentType: 'application/x-protobuf', schemaFormat: 'application/vnd.google.protobuf;version=2', payload: { $ref: './bridge.proto' }, 'x-protobuf-message': 'synthetic.Server' } },
    },
  },
  components: {
    operationTraits: { trace: { summary: 'Trace', tags: [{ name: 'bridge' }], bindings: { ws: {} } } },
    messages: { Client: { name: 'Client', contentType: 'application/x-protobuf', schemaFormat: 'application/vnd.google.protobuf;version=2', payload: { $ref: './bridge.proto' }, correlationId: { location: '$message.header#/id' }, examples: [{ name: 'Raw', payload: '00' }] } },
    securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
  },
};
const converted = adaptAsyncAPI(complex);
assert.deepEqual(Object.keys(converted.operations), ['publish_v2_connection', 'subscribe_v2_connection']);
assert.equal(converted.operations.subscribe_v2_connection.action, 'receive');
assert.equal(converted.operations.publish_v2_connection.messages.length, 2);
assert.deepEqual(converted.operations.publish_v2_connection.traits, complex.channels['/v2/{connection}'].publish.traits);
assert.deepEqual(converted.components.operationTraits.trace, complex.components.operationTraits.trace);
assert.equal(converted.channels['/v2/{connection}'].parameters.connection['x-asyncapi2-schema'].pattern, '^[0-9a-f]+$');
assert.equal(converted.channels['/v2/{connection}'].servers.length, 3);
assert.deepEqual(converted.servers.bootstrap.variables, complex.servers.bootstrap.variables);
assert.deepEqual(converted.components.messages.Client.examples, complex.components.messages.Client.examples);
assert.deepEqual(converted.components.messages.Client.correlationId, complex.components.messages.Client.correlationId);
assert.equal(converted.components.messages.Client.payload.schemaFormat, 'application/vnd.google.protobuf;version=2');
const referenced = structuredClone(complex);
referenced.components.messages.Alias = { $ref: '#/channels/~1v2~1{connection}/subscribe/message' };
assert.equal(adaptAsyncAPI(referenced).components.messages.Alias.$ref, '#/channels/~1v2~1{connection}/messages/subscribe_1');
const prototypeId = structuredClone(v2);
prototypeId.channels['widgets/created'].publish.operationId = '__proto__';
assert.equal(JSON.parse(JSON.stringify(adaptAsyncAPI(prototypeId))).operations.__proto__.action, 'send');
const duplicate = structuredClone(complex);
duplicate.channels['/v2/{connection}'].publish.operationId = 'same';
duplicate.channels['/v2/{connection}'].subscribe.operationId = 'same';
assert.throws(() => adaptAsyncAPI(duplicate), /Duplicate AsyncAPI operation ID/);
const secured = structuredClone(complex);
secured.servers.production.security = [{ token: [] }];
assert.deepEqual(adaptAsyncAPI(secured).servers.production.security, [{ $ref: '#/components/securitySchemes/token' }]);
secured.servers.production.security = [{ token: [], second: [] }];
assert.throws(() => adaptAsyncAPI(secured), /security AND/);
secured.servers.production.security = [{ token: ['write'] }];
assert.throws(() => adaptAsyncAPI(secured), /Scoped AsyncAPI 2 security/);

const directory = await mkdtemp(path.join(os.tmpdir(), 'asyncapi-adapter-'));
try {
  const canonical = path.join(directory, 'bridge.json');
  const text = 'syntax = "proto2";\nmessage Client { optional bytes raw = 1; }\nmessage Server { optional string text = 1; }\n';
  await writeFile(path.join(directory, 'bridge.proto'), text);
  await writeFile(canonical, JSON.stringify(complex));
  const prepared = await prepareAsyncAPI(complex, canonical);
  const descriptor = prepared.components.messages.Client.payload.schema['x-documentation-source'];
  assert.deepEqual(descriptor, { reference: './bridge.proto', format: 'application/vnd.google.protobuf;version=2', text });
  assert.equal(prepared.channels['/v2/{connection}'].messages.subscribe_1.payload.schema['x-documentation-source'].text, text);
  assert.equal(descriptor.type, undefined, 'Protobuf must not masquerade as a JSON type.');
  assert.equal(prepared.servers.bootstrap['x-host-schema'].$ref, `${directory.replaceAll('\\', '/')}/models.yaml#/Host`);
  assert.equal(prepared.channels['/v2/{connection}']['x-upgrade-operation'].$ref, `${directory.replaceAll('\\', '/')}/models.yaml#/Upgrade`);
  const outputs = await writeAsyncAPIPresentations([canonical], path.join(directory, 'derived'));
  assert.deepEqual(JSON.parse(await readFile(outputs[0], 'utf8')), prepared);
  assert.deepEqual(JSON.parse(await readFile(canonical, 'utf8')), complex);
  await rm(path.join(directory, 'bridge.proto'));
  await assert.rejects(prepareAsyncAPI(complex, canonical), /ENOENT/);
} finally {
  await rm(directory, { recursive: true, force: true });
}
const bridgeFile = new URL('./fixtures/bridge.asyncapi.yaml', import.meta.url);
const bridge = parseYaml(await readFile(bridgeFile, 'utf8'));
const preparedBridge = await prepareAsyncAPI(bridge, fileURLToPath(bridgeFile));
const bundled = (await createAsyncAPI({ input: { synthetic: () => preparedBridge } }).getSchemas()).synthetic.bundled;
assert.equal(bundled.operations.publish_v2_connection.action, 'send');
assert.equal(bundled.operations.subscribe_v2_connection.action, 'receive');
assert.equal(bundled.channels['/v2/{connection}'].messages.publish_1.payload.schema['x-documentation-source'].text,
  await readFile(new URL('./fixtures/bridge.proto', import.meta.url), 'utf8'), 'The pinned renderer bundler must retain exact protobuf source.');
if (process.argv[2]) {
  const canonicalFile = path.resolve(process.argv[2]);
  const raw = await readFile(canonicalFile, 'utf8');
  const canonical = parseYaml(raw);
  const presentation = await prepareAsyncAPI(canonical, canonicalFile);
  assert.deepEqual(Object.keys(presentation.operations), ['publish_v2_connection', 'subscribe_v2_connection']);
  assert.deepEqual(Object.keys(presentation.servers), ['production', 'sandbox', 'bootstrap']);
  assert.deepEqual(presentation.servers.bootstrap.variables, canonical.servers.bootstrap.variables);
  const channel = presentation.channels['/v2/{connection}'];
  assert.equal(channel.parameters.connection['x-asyncapi2-schema'].pattern, '^[0-9a-f]+$');
  for (const key of ['x-framing-schema', 'x-upgrade-operation']) assert(channel[key].$ref.endsWith(canonical.channels['/v2/{connection}'][key].$ref.slice(1)));
  for (const key of ['x-host-schema', 'x-environment-schema']) assert(presentation.servers.bootstrap[key].$ref.endsWith(canonical.servers.bootstrap[key].$ref.slice(1)));
  for (const [key, name] of [['publish_1', 'ClientMessage'], ['subscribe_1', 'ServerMessage']]) {
    const message = channel.messages[key];
    assert.equal(message.name, name);
    assert.equal(message.contentType, 'application/x-protobuf');
    const source = message.payload.schema['x-documentation-source'];
    assert.equal(source.format, 'application/vnd.google.protobuf;version=2');
    assert.equal(source.text, await readFile(path.resolve(path.dirname(canonicalFile), source.reference), 'utf8'));
  }
  assert.equal(await readFile(canonicalFile, 'utf8'), raw, 'Canonical bridge adaptation is read-only.');
  console.log('Canonical bridge control passed: both operations, three servers, parameter/extensions and exact protobuf source.');
}
console.log('AsyncAPI presentation adaptation: direction, references, source payloads, metadata and lossless-security checks passed.');
