import assert from 'node:assert/strict';
import { createElement as element } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMagicProxy } from '@scalar/json-magic/magic-proxy';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { useOperation } from 'fumadocs-openapi/operation';
import { dereference } from '@fumadocs/json-schema';
import { writeSchemaPresentations } from '../scripts/presentations.mjs';
import { schemaReferenceGraph } from '../template/lib/schema-reference-graph.mjs';
import { ReferenceSchema } from '../template/components/reference-schema.mjs';
import { OpenAPIResponseGraphs } from '../template/components/openapi-response-graphs.mjs';

const document = createMagicProxy({ components: { schemas: {
  Query: { type: 'object', required: ['records'], properties: { records: { type: 'array', items: { oneOf: [
    { $ref: '#/components/schemas/Record' }, { $ref: '#/components/schemas/Tombstone' }, { $ref: '#/components/schemas/Failure' },
  ] } } } },
  Record: { type: 'object', required: ['recordName', 'fields'], properties: { recordName: { type: 'string' }, fields: { type: 'object' }, child: { $ref: '#/components/schemas/Query' } } },
  Tombstone: { type: 'object', required: ['deleted'], properties: { deleted: { type: 'boolean', enum: [true] } } },
  Failure: { type: 'object', required: ['serverErrorCode'], properties: { serverErrorCode: { type: 'string' } } },
  Challenge: { type: 'object', required: ['trustedDevices'], properties: { trustedDevices: { anyOf: [
    { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } }, { type: 'null' },
  ] } } },
  Progress: { type: 'object', required: ['progress', 'errorCode'], properties: { progress: { type: 'integer' }, errorCode: { type: 'integer', nullable: true } } },
} }, responses: {
  query: { $ref: '#/components/schemas/Query' }, challenge: { $ref: '#/components/schemas/Challenge' }, progress: { $ref: '#/components/schemas/Progress' },
} });
const render = (responses, operationKey = 'SyntheticQuery') => renderToStaticMarkup(element(OpenAPIResponseGraphs, {
  responses, operationKey, SchemaUI: ReferenceSchema, renderMarkdown: (text) => element('p', null, text),
}));
function PublicResponseLayout() {
  const { responses, operation } = useOperation();
  return element(OpenAPIResponseGraphs, { responses, operationKey: operation.operationId, SchemaUI: ReferenceSchema, renderMarkdown: (text) => element('p', null, text) });
}
const Page = createOpenAPIPage({
  generateTypeScriptDefinitions: false, playground: { enabled: false }, components: { SchemaUI: ReferenceSchema },
  content: { renderOperationLayout() { return element(PublicResponseLayout); } },
});
const html = render([
  { status: '200', response: { description: 'Provider records or tombstones.' }, content: { 'application/json': { schema: document.responses.query }, 'text/json': { schema: document.responses.progress } } },
  { status: '409', response: { description: 'Typed provider failure.', headers: { 'Retry-After': { schema: { type: 'integer' }, required: true } } }, content: { 'application/problem+json': { schema: document.components.schemas.Failure } } },
  { status: '204', response: { description: 'No entity.' }, content: {} },
]);
for (const marker of ['Response Body', 'Status', '200', '409', '204', 'application/json', 'text/json', 'application/problem+json',
  'Provider records or tombstones.', 'Typed provider failure.', 'Retry-After', 'No response body content declared.', 'oneOf[0]', 'oneOf[1]', 'oneOf[2]',
  'recordName', 'fields', 'deleted', 'serverErrorCode', 'progress', 'errorCode', 'nullable', 'Yes']) assert(html.includes(marker), `Visible response graph must retain ${marker}.`);
assert(!html.includes('<script'), 'Response contracts must be rendered HTML, not serialized scripts.');
assert.equal((html.match(/>Query<\/h4>/g) || []).length, 1, 'Recursive components render once per response graph.');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, 'Status/media/component anchors must be unique.');
for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert(ids.includes(target), `Component link must resolve to ${target}.`);
const challenge = render([{ status: '200', response: {}, content: { 'application/json': { schema: document.responses.challenge } } }], 'SyntheticChallenge');
for (const marker of ['trustedDevices', 'anyOf[0]', 'anyOf[1]', 'null', 'integer', 'Yes']) assert(challenge.includes(marker));
const noSchema = render([{ status: '202', response: {}, content: { 'application/json': {} } }]);
assert(noSchema.includes('No response body schema declared.'));
assert.equal(render([]), '');
const request = renderToStaticMarkup(element(ReferenceSchema, {
  root: document.responses.query, client: { name: 'body', rootId: 'request', required: true }, renderMarkdown: (text) => text,
}));
assert(request.includes('body (required)') && request.includes('records') && request.includes('Yes'), 'The shared request renderer preserves its required root/fields.');
const fixtureFile = fileURLToPath(new URL('./fixtures/references.openapi.yaml', import.meta.url));
const fixture = await createOpenAPI({ input: [fixtureFile] }).getSchema(fixtureFile);
const fixtureHTML = renderToStaticMarkup(element(Page, { payload: { bundled: fixture.bundled }, operations: [{ path: '/records', method: 'post' }] }));
for (const marker of ['responseCursor', 'responseProgress', 'responseErrorCode', 'serverErrorCode', '429', 'default', 'text/json', 'application/problem+json', 'anyOf[2]', 'null', 'Yes']) {
  assert(fixtureHTML.includes(marker), `Pinned public response hook must render ${marker}.`);
}
if (process.argv[2]) {
  const root = path.resolve(process.argv[2]);
  const files = ['photos.openapi.yaml', 'photos-upload.openapi.yaml', 'auth.openapi.yaml'].map((file) => path.join(root, 'external', file));
  const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'canonical-response-graphs-'));
  try {
    const prepared = await writeSchemaPresentations({ openapi: files, asyncapi: [], graphql: [] }, directory);
    const schemas = Object.values(await createOpenAPI({ input: prepared.openapi }).getSchemas());
    const controls = {
      PhotosQueryRecords: ['CKQueryResponse', 'CKRecord', 'CKTombstoneRecord', 'CKErrorItem', 'anyOf[0]', 'anyOf[1]', 'anyOf[2]', 'serverErrorCode'],
      PhotosUploadStatus: ['PhotosUploadStatusEntries', 'progress', 'errorCode', 'null', '429', 'PhotosSessionErrorResponse'],
      GetAuthChallenge: ['trustedPhoneNumber', 'fsaChallenge', 'sourceAppId', 'oneOf[1]', 'anyOf', 'null', 'AuthFailure', 'default'],
    };
    for (const schema of schemas) {
      const proxy = createMagicProxy(schema.bundled);
      for (const [route, item] of Object.entries(proxy.paths)) for (const [method, operation] of Object.entries(item)) {
        if (!controls[operation?.operationId]) continue;
        const responses = Object.entries(operation.responses).map(([status, rawResponse]) => {
          const response = dereference(rawResponse);
          return { status, response, content: Object.fromEntries(Object.entries(response.content || {}).map(([mediaType, media]) => [mediaType, dereference(media)])) };
        });
        const visible = render(responses, operation.operationId);
        const publicHookHTML = renderToStaticMarkup(element(Page, { payload: { bundled: schema.bundled }, operations: [{ path: route, method }] }));
        for (const marker of controls[operation.operationId]) assert(visible.includes(marker), `${operation.operationId} response graph must visibly include ${marker}.`);
        for (const marker of controls[operation.operationId]) assert(publicHookHTML.includes(marker), `${operation.operationId} public renderer hook must visibly include ${marker}.`);
        for (const response of responses) {
          assert(visible.includes(`>${response.status}</code>`));
          for (const [mediaType, media] of Object.entries(response.content)) {
            assert(visible.includes(`>${mediaType}</code>`));
            if (media.schema === undefined) continue;
            const graph = schemaReferenceGraph(media.schema);
            if (operation.operationId === 'PhotosQueryRecords' && response.status === '200') {
              const error = graph.find((section) => section.key.endsWith('/CKErrorItem'));
              assert(error.rows.some((row) => row.path === '$.serverErrorCode' && row.required));
              assert(error.rows.some((row) => row.path === '$.reason' && (row.constraints.nullable || row.type.includes('null'))));
            }
          }
        }
        delete controls[operation.operationId];
      }
    }
    assert.deepEqual(Object.keys(controls), [], 'Every canonical operation control must run.');
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), before);
    console.log('Canonical response SSR controls passed: QueryRecords variants, UploadStatus 429/progress/errors and AuthChallenge/default failures.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
console.log('Response graph SSR: all statuses/media, recursive alternatives, nullable/anyOf, required fields, headers and anchors passed.');
