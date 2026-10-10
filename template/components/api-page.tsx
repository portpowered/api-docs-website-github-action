'use client';

import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { createAsyncAPIPage } from '@fumadocs/asyncapi/ui';
import { createJSONMediaOptions } from '../lib/media-adapters.mjs';
import site from '../lib/site-config.json';
import { ReferenceSchema } from './reference-schema';

export const OpenAPIPage = createOpenAPIPage({
  ...createJSONMediaOptions(site.jsonMediaTypes),
  ...(site.schemaView === 'references' ? {
    components: { SchemaUI: ReferenceSchema },
    generateTypeScriptDefinitions: false,
  } : {}),
});
export const AsyncAPIPage = createAsyncAPIPage({
  schemaUI: {
    render(options, { SchemaUI }) {
      const source = (options.root as { 'x-documentation-source'?: { reference: string; format: string; text: string } })?.['x-documentation-source'];
      if (!source) return <SchemaUI {...options} />;
      return <section className="my-4 min-w-0" aria-label="Payload source schema">
        <p><strong>Source schema:</strong> <code>{source.reference}</code></p>
        <p><strong>Schema format:</strong> <code>{source.format}</code></p>
        <pre className="overflow-x-auto rounded-lg border p-4 text-sm"><code>{source.text}</code></pre>
      </section>;
    },
  },
});
