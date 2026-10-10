import { createElement as element } from 'react';

/** Keep non-JSON source documentation visible when the native message accordion is closed. */
export function AsyncAPIPresentation({ action, messages, children }) {
  const sources = messages.flatMap((message) => {
    const source = message.payload?.['x-documentation-source'];
    if (!source) return [];
    return [element('section', { key: message.name, className: 'my-4 min-w-0', 'aria-label': `${message.name} payload source schema` },
      element('h3', null, message.name),
      message.contentType && element('p', null, element('strong', null, 'Content type: '), element('code', null, message.contentType)),
      element('p', null, element('strong', null, 'Source schema: '), element('code', null, source.reference)),
      element('p', null, element('strong', null, 'Schema format: '), element('code', null, source.format)),
      element('pre', { className: 'overflow-x-auto rounded-lg border p-4 text-sm' }, element('code', null, source.text)))];
  });
  return element('div', null,
    element('p', { className: 'font-mono font-semibold', 'aria-label': 'Operation direction' }, action.toUpperCase()),
    children, ...sources);
}
