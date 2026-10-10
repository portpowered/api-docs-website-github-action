import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AsyncAPIPresentation } from '../template/components/asyncapi-presentation.mjs';

const text = 'syntax = "proto2";\nmessage ClientMessage { optional string field = 1; }\n// <script>literal source</script>\n';
for (const action of ['send', 'receive']) {
  const html = renderToStaticMarkup(createElement(AsyncAPIPresentation, {
    action,
    messages: [{ name: 'ClientMessage', contentType: 'application/x-protobuf', payload: {
      'x-documentation-source': { reference: './bridge.proto', format: 'application/vnd.google.protobuf;version=2', text },
    } }],
    children: createElement('div', null, 'Native operation slots'),
  }));
  for (const marker of [action.toUpperCase(), 'Native operation slots', 'Source schema:', './bridge.proto', 'Schema format:', 'application/vnd.google.protobuf;version=2', 'application/x-protobuf', 'ClientMessage', 'optional string field = 1;']) {
    assert(html.includes(marker), `Static visible content must include ${marker}.`);
  }
  assert(!html.includes('<script>'), 'Exact source text must be escaped, never executed or hidden in script payloads.');
  assert(html.includes('&lt;script&gt;literal source&lt;/script&gt;'));
}
const json = renderToStaticMarkup(createElement(AsyncAPIPresentation, {
  action: 'send', messages: [{ name: 'JSON', payload: { type: 'object' } }], children: 'Native JSON schema',
}));
assert(json.includes('Native JSON schema'));
assert(!json.includes('Source schema:'), 'JSON messages retain native rendering without an invented source descriptor.');
console.log('AsyncAPI static presentation: visible directions, exact escaped source and native JSON preservation passed.');
