import assert from 'node:assert/strict';
import { parseJSONMediaTypes } from '../scripts/json-media-types.mjs';

assert.deepEqual(parseJSONMediaTypes(), []);
assert.deepEqual(parseJSONMediaTypes(' , plain/text, */*, '), ['plain/text', '*/*']);
assert.deepEqual(parseJSONMediaTypes('plain/text,text/plain;charset=UTF-8,*/*'),
  ['plain/text', 'text/plain;charset=UTF-8', '*/*']);
assert.deepEqual(parseJSONMediaTypes('Text/Plain; Charset="UTF-8"; profile="a,b",application/json'),
  ['Text/Plain; Charset="UTF-8"; profile="a,b"', 'application/json']);
assert.deepEqual(parseJSONMediaTypes('text/plain; profile="a\\"b"'), ['text/plain; profile="a\\"b"']);
for (const value of [
  'plain', 'plain/', '/text', 'text/*', 'text/plain; charset', 'text/plain; charset=',
  'text/plain; charset="unterminated', 'text/plain; charset=utf 8', 'text/plain; charset="bad\u0001"',
  'text/plain\r\nX-Injected: yes', 'text/plain; charset="bad\r\nvalue"',
  '\r\ntext/plain', 'text/plain\n',
]) {
  assert.throws(() => parseJSONMediaTypes(value), /Invalid JSON media type/, value);
}
console.log('JSON media input: exact parameter spelling, quoted values, comma lists and invalid inputs passed.');
