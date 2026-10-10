import { createElement as element } from 'react';
import { referenceAnchor } from '../lib/schema-reference-graph.mjs';

/** Render every response contract outside collapsed status/media selectors. */
export function OpenAPIResponseGraphs({ responses, operationKey, SchemaUI, renderMarkdown, resolve = (value) => value }) {
  if (!responses.length) return null;
  return element('section', { 'aria-label': 'Response Body', className: 'space-y-6' },
    element('h3', null, 'Response Body'),
    ...responses.map(({ status, response, content }) => element('section', {
      key: status, id: referenceAnchor('response', `${operationKey}:${status}`), className: 'scroll-mt-24 space-y-4',
      'aria-label': `Response ${status}`,
    },
    element('h4', null, 'Status ', element('code', null, status)),
    response.description && renderMarkdown(response.description),
    ...Object.entries(response.headers || {}).map(([name, rawHeader]) => {
      const header = resolve(rawHeader);
      return element('section', { key: `header:${name}` },
        element('h5', null, 'Header ', element('code', null, name)),
        header.description && renderMarkdown(header.description),
        header.schema !== undefined && element(SchemaUI, {
          root: header.schema, readOnly: true, renderMarkdown,
          client: { rootId: referenceAnchor('response-header', `${operationKey}:${status}:${name}`), name, required: header.required },
        }));
    }),
    ...Object.entries(content).map(([mediaType, media]) => element('section', {
      key: mediaType, 'aria-label': `${status} ${mediaType}`,
    },
    element('h5', null, 'Media type ', element('code', null, mediaType)),
    media.schema !== undefined ? element(SchemaUI, {
      root: media.schema, readOnly: true, renderMarkdown,
      client: { rootId: referenceAnchor('response-schema', `${operationKey}:${status}:${mediaType}`), name: 'response', as: 'body' },
    }) : element('p', null, 'No response body schema declared.'))),
    !Object.keys(content).length && element('p', null, 'No response body content declared.'))));
}
