'use client';

import type { ReactNode } from 'react';
import { createOpenAPIPage } from 'fumadocs-openapi/ui';
import { useOperation as useOpenAPIOperation } from 'fumadocs-openapi/operation';
import { useComponents as useOpenAPIComponents, useOpenAPI } from 'fumadocs-openapi';
import { OpenAPIResponseGraphs } from './openapi-response-graphs.mjs';
import { createAsyncAPIPage } from '@fumadocs/asyncapi/ui';
import { useOperation } from '@fumadocs/asyncapi/operation';
import { AsyncAPIPresentation } from './asyncapi-presentation.mjs';
import { createJSONMediaOptions } from '../lib/media-adapters.mjs';
import site from '../lib/site-config.json';
import { ReferenceSchema } from './reference-schema';

function OpenAPIReferenceResponses() {
  const { responses, operation, method, path } = useOpenAPIOperation();
  const { Markdown } = useOpenAPIComponents();
  const { resolve } = useOpenAPI().doc;
  return <OpenAPIResponseGraphs responses={responses} operationKey={operation.operationId || `${method}:${path}`}
    SchemaUI={ReferenceSchema} resolve={resolve} renderMarkdown={(text: string) => <Markdown md={text} />} />;
}

function OpenAPIReferenceLayout({ slots, webhook = false }: { slots: Record<string, ReactNode>; webhook?: boolean }) {
  return <div className={webhook ? 'flex flex-col-reverse gap-x-6 gap-y-4 @4xl:flex-row @4xl:items-start' : 'flex flex-col gap-x-6 gap-y-4 @4xl:flex-row @4xl:items-start'}>
    <div className="min-w-0 flex-1">
      {slots.header}{slots.apiPlayground}{slots.description}{slots.authSchemes}{slots.parameters}{slots.body}
      <OpenAPIReferenceResponses />
      {slots.callbacks}
    </div>
    <div className="@4xl:sticky @4xl:top-[calc(var(--fd-docs-row-1,2rem)+1rem)] @4xl:w-[400px]">{webhook ? slots.requests : slots.apiExample}</div>
  </div>;
}

export const OpenAPIPage = createOpenAPIPage({
  ...createJSONMediaOptions(site.jsonMediaTypes),
  ...(site.schemaView === 'references' ? {
    components: { SchemaUI: ReferenceSchema },
    generateTypeScriptDefinitions: false,
    content: {
      renderOperationLayout(slots) { return <OpenAPIReferenceLayout slots={slots} />; },
      renderWebhookLayout(slots) { return <OpenAPIReferenceLayout slots={slots} webhook />; },
    },
  } : {}),
});
function AsyncOperationLayout({ slots }: { slots: Record<string, ReactNode> }) {
  const { action, messages } = useOperation();
  return <AsyncAPIPresentation action={action} messages={messages.map((item) => ({
    name: item.name,
    contentType: item.message.contentType,
    payload: item.payload,
  }))}>
    {slots.header}{slots.description}{slots.server}{slots.channel}{slots.authSchemes}
    {slots.parameters}{slots.messages}{slots.reply}{slots.bindings}
  </AsyncAPIPresentation>;
}

export const AsyncAPIPage = createAsyncAPIPage({
  content: {
    renderOperationLayout(slots) { return <AsyncOperationLayout slots={slots} />; },
  },
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
