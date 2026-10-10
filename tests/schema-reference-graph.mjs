import assert from 'node:assert/strict';
import { createMagicProxy } from '@scalar/json-magic/magic-proxy';
import { schemaReferenceGraph, referenceAnchor } from '../template/lib/schema-reference-graph.mjs';

const document = createMagicProxy({
  components: { schemas: {
    Root: { allOf: [
      { oneOf: [{ $ref: '#/components/schemas/Create' }, { $ref: '#/components/schemas/Delete' }] },
      { type: 'object', required: ['revision'], properties: { revision: { type: 'string' } } },
    ] },
    Create: { type: 'object', required: ['title'], properties: {
      title: { type: 'string', minLength: 1 }, child: { $ref: '#/components/schemas/Root' },
    } },
    Delete: { type: 'object', required: ['deleted'], properties: { deleted: { type: 'integer', enum: [1] } } },
  } },
  root: { $ref: '#/components/schemas/Root' },
});
const graph = schemaReferenceGraph(document.root);
assert.equal(graph.length, 4, 'Recursive refs must render once, without an intersection cross-product.');
assert(graph.find((section) => section.key.endsWith('/Create')).rows.some((row) => row.path === '$.title' && row.required));
assert(graph.find((section) => section.key.endsWith('/Delete')).rows.some((row) =>
  row.path === '$.deleted' && row.required && row.constraints.enum[0] === 1));
assert(graph.find((section) => section.key.endsWith('/Root')).rows.some((row) => row.path.endsWith('.revision') && row.required));
assert(graph.find((section) => section.key.endsWith('/Root')).rows.some((row) => row.path.includes('allOf[0].oneOf[1]')));
assert(referenceAnchor('body', '#/components/schemas/Create').startsWith('body-component-'));
const missing = createMagicProxy({ root: { $ref: '#/components/schemas/Missing' } });
assert.throws(() => schemaReferenceGraph(missing.root), /Unresolved schema reference/);
console.log('Reference graph: recursive refs, all alternatives, required fields and unresolved-ref rejection passed.');

