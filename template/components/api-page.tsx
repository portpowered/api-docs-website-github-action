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
export const AsyncAPIPage = createAsyncAPIPage({});
