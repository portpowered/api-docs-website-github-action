import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateFiles as generateOpenAPIFiles } from 'fumadocs-openapi';
import { generateFiles as generateAsyncAPIFiles } from '@fumadocs/asyncapi';
import { createOpenAPI } from 'fumadocs-openapi/server';
import { createAsyncAPI } from '@fumadocs/asyncapi/server';
import { generateGraphQLFiles } from '../../scripts/graphql.mjs';
import { addAsyncAPIBindingLinks, addOpenAPIBindingLinks, addSchemaPagesToOpenAPIMeta, generateSchemaPages } from '../../scripts/schema-pages.mjs';
import config from '../lib/site-config.json' with { type: 'json' };

const contentRoot = path.join(process.cwd(), 'content/docs');
await mkdir(contentRoot, { recursive: true });

const schemaBindings = await generateSchemaPages({
  bindingsPath: config.schemaBindings,
  sourceDocuments: [...config.schemas.openapi, ...config.schemas.asyncapi],
  sourceRoot: config.sourceRoot,
  contentRoot,
});

if (config.schemas.openapi.length) {
  const openapi = createOpenAPI({ input: config.schemas.openapi });
  await generateOpenAPIFiles({
    input: openapi,
    output: path.join(contentRoot, 'openapi'),
    per: 'operation',
    groupBy: 'tag',
    meta: true,
    beforeWrite(files) {
      addOpenAPIBindingLinks(files, schemaBindings.openapi);
    },
  });
}
if (schemaBindings.pages.length) await addSchemaPagesToOpenAPIMeta(contentRoot);

if (config.schemas.asyncapi.length) {
  const asyncapi = createAsyncAPI({ input: config.schemas.asyncapi });
  await generateAsyncAPIFiles({
    input: asyncapi,
    output: path.join(contentRoot, 'asyncapi'),
    per: 'operation',
    groupBy: 'tag',
    meta: true,
    beforeWrite(files) {
      addAsyncAPIBindingLinks(files, schemaBindings.asyncapi);
    },
  });
}

if (config.schemas.graphql.length) await generateGraphQLFiles(config.schemas.graphql, contentRoot, { schemaBindings: schemaBindings.graphql });

const landing = ['---', `title: ${JSON.stringify(config.title)}`, 'description: API reference generated from the source schemas.', '---', '', `# ${config.title}`, '', 'Browse the API reference in the sidebar.', ''].join('\n');
await writeFile(path.join(contentRoot, 'index.mdx'), landing);
const pages = ['index', ...Object.entries(config.schemas).filter(([, files]) => files.length).map(([kind]) => kind)];
try {
  const guidesInfo = await stat(path.join(contentRoot, 'guides'));
  if (guidesInfo.isDirectory()) pages.push('guides');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
await writeFile(path.join(contentRoot, 'meta.json'), JSON.stringify({ title: 'API Reference', pages }));
