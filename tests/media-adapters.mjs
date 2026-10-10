import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createJSONMediaOptions } from '../template/lib/media-adapters.mjs';
import { isMediaTypeSupported } from 'fumadocs-openapi/requests';
import { parseJSONMediaTypes } from '../scripts/json-media-types.mjs';

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
const parameterizedMedia = 'text/plain;charset=UTF-8';
const parameterizedOptions = createJSONMediaOptions(parseJSONMediaTypes(parameterizedMedia));
assert.equal(isMediaTypeSupported(parameterizedMedia, parameterizedOptions.mediaAdapters), true);
assert.equal(isMediaTypeSupported(parameterizedMedia, createJSONMediaOptions().mediaAdapters), false,
  'Parameterized plain text must require explicit JSON opt-in.');
assert.equal(parameterizedOptions.mediaAdapters[parameterizedMedia], parameterizedOptions.mediaAdapters['text/plain'],
  'Fumadocs must resolve its normalized base type to the configured JSON encoder.');
assert.deepEqual(JSON.parse(parameterizedOptions.mediaAdapters[parameterizedMedia].encode({ body })), body);
const parameterizedCurl = parameterizedOptions.codeUsages.get('curl').generate({ ...request, bodyMediaType: parameterizedMedia });
assert(parameterizedCurl.includes('Content-Type: text/plain;charset=UTF-8'),
  'Parameterized media must retain its exact request header.');
const variantCurl = parameterizedOptions.codeUsages.get('curl').generate({ ...request, bodyMediaType: 'Text/Plain; charset=utf-8' });
assert(variantCurl.includes('Content-Type: Text/Plain; charset=utf-8') && variantCurl.includes('"enabled": true'),
  'cURL must use the same base encoder dispatch while preserving the selected schema header.');
const quotedMedia = 'Text/Plain; profile="a,b\'$(example)"';
const quotedOptions = createJSONMediaOptions(parseJSONMediaTypes(quotedMedia));
assert.equal(isMediaTypeSupported(quotedMedia, quotedOptions.mediaAdapters), true,
  'The normalized upstream dispatch must support quoted parameters and base type case.');
const quotedCurl = quotedOptions.codeUsages.get('curl').generate({ ...request, bodyMediaType: quotedMedia });
const expectedQuotedHeader = "'" + `Content-Type: ${quotedMedia}`.replaceAll("'", "'\"'\"'") + "'";
assert(quotedCurl.includes(`-H ${expectedQuotedHeader}`),
  'A parameter containing shell syntax must remain one literal POSIX header argument.');
console.log('Additional JSON media adapters: encoding, header, snippets, quoting and opt-in controls passed.');
