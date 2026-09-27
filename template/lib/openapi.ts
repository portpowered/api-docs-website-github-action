import { createOpenAPI } from 'fumadocs-openapi/server';
import site from './site-config.json';

export const openapi = createOpenAPI({ input: site.schemas.openapi });
