import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAsyncAPI } from '@fumadocs/asyncapi/server';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { writeSchemaPresentations } from '../scripts/presentations.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'schema-presentations-'));
try {
  const source = path.join(directory, 'root.json');
  const dependency = path.join(directory, 'models.json');
  const document = {
    openapi: '3.0.3', info: { title: 'Synthetic reference graph', version: '1' }, paths: {},
    components: { schemas: { Root: {
      type: 'object', properties: { 'x-wire-name': { $ref: './models.json#/components/schemas/Model' } },
      'x-binary-layout': { fields: [{ $ref: './missing.proto#/enums/Framing/values/Opcode' }], length: 4 },
    } } },
  };
  const models = { openapi: '3.0.3', info: { title: 'Synthetic models', version: '1' }, paths: {},
    components: { schemas: { Model: { type: 'object', properties: { parent: { $ref: './root.json#/components/schemas/Root' } },
      'x-source': { $ref: './missing.proto#/messages/Model' } } } } };
  await writeFile(source, JSON.stringify(document));
  await writeFile(dependency, JSON.stringify(models));
  const prepared = await writeSchemaPresentations({ openapi: [source], asyncapi: [], graphql: [] }, path.join(directory, 'derived'));
  const result = JSON.parse(await readFile(prepared.openapi[0], 'utf8'));
  const root = result.components.schemas.Root;
  assert.deepEqual(root['x-binary-layout'], { fields: [{ 'x-documentation-reference': './missing.proto#/enums/Framing/values/Opcode' }], length: 4 });
  const reference = root.properties['x-wire-name'].$ref;
  assert(reference.startsWith(path.join(directory, 'derived').replaceAll('\\', '/')), 'An x-named wire property remains a real schema reference.');
  const copiedModel = JSON.parse(await readFile(reference.split('#')[0], 'utf8')).components.schemas.Model;
  assert.equal(copiedModel.properties.parent.$ref, `${prepared.openapi[0]}#/components/schemas/Root`);
  assert.equal(copiedModel['x-source']['x-documentation-reference'], './missing.proto#/messages/Model');
  await createOpenAPI({ input: prepared.openapi }).getSchemas();
  assert.deepEqual(JSON.parse(await readFile(source, 'utf8')), document);
  assert.deepEqual(JSON.parse(await readFile(dependency, 'utf8')), models);

  if (process.argv[2]) {
    const canonical = path.resolve(process.argv[2]);
    const openapi = path.join(path.dirname(canonical), 'external', 'bridge-websocket.openapi.yaml');
    const before = await Promise.all([canonical, openapi].map((file) => readFile(file, 'utf8')));
    const graph = await writeSchemaPresentations({ openapi: [openapi], asyncapi: [canonical], graphql: [] }, path.join(directory, 'canonical-derived'));
    const asyncDocument = JSON.parse(await readFile(graph.asyncapi[0], 'utf8'));
    assert.deepEqual(Object.keys(asyncDocument.operations), ['publish_v2_connection', 'subscribe_v2_connection']);
    const framing = asyncDocument.channels['/v2/{connection}']['x-framing-schema'];
    assert.equal(framing['x-documentation-reference'], './external/bridge-websocket.openapi.yaml#/components/schemas/Frame');
    assert.equal(framing.$ref, undefined);
    const copied = JSON.parse(await readFile(graph.openapi[0], 'utf8'));
    assert(copied.components.schemas.Frame.properties.payload, 'Real typed schema properties survive adaptation.');
    const seen = [];
    const inspect = (value, extension = false) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'x-documentation-reference') seen.push(child);
        if (key === '$ref') assert(!extension, 'Vendor extension references must be inert.');
        inspect(child, extension || key.startsWith('x-'));
      }
    };
    inspect(copied);
    assert(seen.some((reference) => reference.includes('.proto#/enums/Framing/values/')), 'Framing provenance must retain its exact protobuf fragment.');
    await createOpenAPI({ input: graph.openapi }).getSchemas();
    const bundled = await createAsyncAPI({ input: graph.asyncapi }).getSchemas();
    assert.equal(Object.values(bundled)[0].bundled.operations.publish_v2_connection.action, 'send');
    assert.deepEqual(await Promise.all([canonical, openapi].map((file) => readFile(file, 'utf8'))), before);
    console.log('Canonical bridge presentation graph bundles with typed schemas, exact framing provenance and unchanged sources.');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log('Presentation reference graph: vendor provenance, recursive schema links and x-named wire properties passed.');
