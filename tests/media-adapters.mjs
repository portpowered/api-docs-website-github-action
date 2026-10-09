import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createJSONMediaOptions } from '../template/lib/media-adapters.mjs';
import { isMediaTypeSupported } from 'fumadocs-openapi/requests';

const options = createJSONMediaOptions(['plain/text']);
const body = { name: "Today's \"雪\" \\ folder", enabled: true, optional: null, children: [1, 2] };
const adapter = options.mediaAdapters['plain/text'];
assert.equal(isMediaTypeSupported('plain/text', options.mediaAdapters), true);
assert.equal(isMediaTypeSupported('plain/text', createJSONMediaOptions().mediaAdapters), false,
  'A media alias must require explicit opt-in.');
assert.deepEqual(JSON.parse(adapter.encode({ body })), body, 'Playground must send complete JSON.');
const js = adapter.generateExample({ body }, { lang: 'js' });
assert.deepEqual(JSON.parse(vm.runInNewContext(js + '\nbody')), body, 'JavaScript snippet must encode complete JSON.');
const imports = [];
const go = adapter.generateExample({ body }, { lang: 'go', addImport(value) { imports.push(value); } });
assert.deepEqual(imports, ['strings']);
assert(go.includes('strings.NewReader('), 'Go snippet must include its request reader.');
assert.deepEqual(JSON.parse(JSON.parse(go.slice('body := strings.NewReader('.length, -1))), body);
const request = {
  method: 'post', url: 'https://example.invalid/register', bodyMediaType: 'plain/text', body,
  header: {}, cookie: {}, path: {}, query: {},
};
const curl = options.codeUsages.get('curl').generate(request);
assert(curl.includes('Content-Type: plain/text'), 'Keep the actual provider header.');
assert(curl.includes('"enabled": true') && curl.includes('"optional": null'), 'cURL must contain JSON fields.');
assert(!curl.includes('<name>'), 'Do not reinterpret the object as XML.');
assert(curl.includes('Today\'"\'"\'s'), 'Apostrophes must remain a single POSIX body argument.');
assert.equal(adapter.generateExample({ body }, { lang: 'unsupported' }), undefined);
assert.equal(adapter.encode({ body: null }), 'null');
assert.equal(adapter.encode({ body: 'literal' }), '"literal"');
console.log('Additional JSON media adapters: encoding, header, snippets, quoting and opt-in controls passed.');
