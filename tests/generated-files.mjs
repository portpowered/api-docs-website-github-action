import assert from 'node:assert/strict';
import { mergeGeneratedFiles } from '../scripts/generated-files.mjs';

const files = [
  { path: 'unknown/meta.json', content: '{"title":"Unknown","pages":["first","second"]}' },
  { path: 'unknown/first.mdx', content: 'first operation' },
  { path: 'unknown/meta.json', content: '{"title":"Unknown","pages":["second","third"]}' },
  { path: 'unknown/third.mdx', content: 'third operation' },
];
mergeGeneratedFiles(files);
assert.equal(files.length, 3, 'Only one write may target a shared folder inventory.');
assert.deepEqual(JSON.parse(files[0].content), { title: 'Unknown', pages: ['first', 'second', 'third'] });
assert.equal(files[1].content, 'first operation', 'Do not modify rendered operation content.');
assert.throws(() => mergeGeneratedFiles([
  { path: 'same.mdx', content: 'one' }, { path: 'same.mdx', content: 'two' },
]), /Duplicate generated page/);
assert.throws(() => mergeGeneratedFiles([
  { path: 'meta.json', content: '{"title":"A","pages":["first"]}' },
  { path: 'meta.json', content: '{"title":"B","pages":["second"]}' },
]), /Conflicting generated folder metadata/);
console.log('Generated folder inventories merge without losing operations; collisions reject.');
