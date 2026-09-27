import { createAsyncAPI } from '@fumadocs/asyncapi/server';
import site from './site-config.json';

export const asyncapi = createAsyncAPI({ input: site.schemas.asyncapi });
