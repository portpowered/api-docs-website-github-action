import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFiles as generateOpenAPIFiles } from 'fumadocs-openapi';
import { generateFiles as generateAsyncAPIFiles } from '@fumadocs/asyncapi';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { createAsyncAPI } from '@fumadocs/asyncapi/server';
import { generateGraphQLFiles } from '../../scripts/graphql.mjs';
import config from '../lib/site-config.json' with { type: 'json' };

const contentRoot = path.join(process.cwd(), 'content/docs');
await mkdir(contentRoot, { recursive: true });

if (config.schemas.openapi.length) {
  const openapi = createOpenAPI({ input: config.schemas.openapi });
  await generateOpenAPIFiles({ input: openapi, output: path.join(contentRoot, 'openapi'), per: 'operation', groupBy: 'tag', meta: true });
}

if (config.schemas.asyncapi.length) {
  const asyncapi = createAsyncAPI({ input: config.schemas.asyncapi });
  await generateAsyncAPIFiles({ input: asyncapi, output: path.join(contentRoot, 'asyncapi'), per: 'operation', groupBy: 'tag', meta: true });
}

if (config.schemas.graphql.length) await generateGraphQLFiles(config.schemas.graphql, contentRoot);

const landing = ['---', `title: ${JSON.stringify(config.title)}`, 'description: API reference generated from the source schemas.', '---', '', `# ${config.title}`, '', 'Browse the API reference in the sidebar.', ''].join('\n');
await writeFile(path.join(contentRoot, 'index.mdx'), landing);
const pages = ['index', ...Object.entries(config.schemas).filter(([, files]) => files.length).map(([kind]) => kind)];
await writeFile(path.join(contentRoot, 'meta.json'), JSON.stringify({ title: 'API Reference', pages }));
