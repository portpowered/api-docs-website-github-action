import { createElement as element } from 'react';
import { schemaReferenceGraph, referenceAnchor } from '../lib/schema-reference-graph.mjs';

export function ReferenceSchema({ root, client, renderMarkdown }) {
  const sections = schemaReferenceGraph(root);
  return element('section', { id: client.rootId, className: 'my-4 space-y-6' },
    element('p', null, client.name, ' ', client.required ? '(required)' : ''),
    ...sections.map((section) => element('section', {
      key: section.key, id: referenceAnchor(client.rootId, section.key), className: 'scroll-mt-24',
    },
    element('h4', null, section.key === '$root' ? 'Schema' : section.key.split('/').at(-1)),
    element('div', { className: 'overflow-x-auto' }, element('table', { className: 'w-full text-sm' },
      element('thead', null, element('tr', null, ...['Field or alternative', 'Type', 'Required', 'Contract'].map((name) => element('th', { key: name }, name)))),
      element('tbody', null, ...section.rows.map((row) => element('tr', { key: row.path },
        element('td', null, element('code', null, row.path)),
        element('td', null, String(row.type), ' ', row.reference && element('a', { href: '#' + referenceAnchor(client.rootId, row.reference) }, row.reference.split('/').at(-1))),
        element('td', null, row.required || (section.key === '$root' && row.path === '$' && client.required) ? 'Yes' : 'No'),
        element('td', null, row.description && renderMarkdown(row.description),
          ...Object.entries(row.constraints).map(([name, value]) => element('div', { key: name },
            element('strong', null, name + ': '), element('code', { className: 'whitespace-pre-wrap break-all' }, JSON.stringify(value)))))))))))));
}
