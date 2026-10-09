'use client';

import { schemaReferenceGraph, referenceAnchor } from '../lib/schema-reference-graph.mjs';

export function ReferenceSchema({ root, client, renderMarkdown }: any) {
  const sections = schemaReferenceGraph(root);
  return <section id={client.rootId} className="my-4 space-y-6">
    <p>{client.name} {client.required ? '(required)' : ''}</p>
    {sections.map((section: any) => <section key={section.key}
      id={referenceAnchor(client.rootId, section.key)} className="scroll-mt-24">
      <h4>{section.key === '$root' ? 'Schema' : section.key.split('/').at(-1)}</h4>
      <div className="overflow-x-auto"><table className="w-full text-sm">
        <thead><tr><th>Field or alternative</th><th>Type</th><th>Required</th><th>Contract</th></tr></thead>
        <tbody>{section.rows.map((row: any) => <tr key={row.path}>
          <td><code>{row.path}</code></td>
          <td>{String(row.type)} {row.reference && <a href={'#' + referenceAnchor(client.rootId, row.reference)}>
            {row.reference.split('/').at(-1)}</a>}</td>
          <td>{row.required || (section.key === '$root' && row.path === '$' && client.required) ? 'Yes' : 'No'}</td>
          <td>{row.description && renderMarkdown(row.description)}
            {Object.entries(row.constraints).map(([name, value]) => <div key={name}>
              <strong>{name}: </strong><code className="whitespace-pre-wrap break-all">{JSON.stringify(value)}</code>
            </div>)}</td>
        </tr>)}</tbody>
      </table></div>
    </section>)}
  </section>;
}
