import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repoRoot, 'tests', 'fixtures');
const tempRoot = await mkdtemp(join(tmpdir(), 'api-docs-smoke-'));
const outputRoot = join(tempRoot, 'site');
const basePath = '/go-ring';

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, fullPath));
    else files.push(relative(root, fullPath));
  }
  return files;
}

try {
  const build = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      API_DOCS_TITLE: 'Smoke Test API Reference',
      API_DOCS_BASE_PATH: basePath,
      API_DOCS_OPENAPI: 'openapi.yaml,service-a/openapi.yaml,service-b/openapi.yaml',
      API_DOCS_ASYNCAPI: 'asyncapi.yaml,asyncapi3.yaml',
      API_DOCS_GRAPHQL: 'schema.graphql',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_OUTPUT: outputRoot,
    },
  });

  assert.equal(build.status, 0, `Build failed.\n${build.stdout}\n${build.stderr}`);
  const files = await listFiles(outputRoot);
  assert(files.includes('index.html'), 'Build must emit the home page.');
  assert(files.includes(join('docs', 'index.html')), 'Build must emit the Fumadocs documentation index.');

  const htmlFiles = files.filter((file) => file.endsWith('.html'));
  const pages = await Promise.all(htmlFiles.map(async (file) => ({
    file,
    html: await readFile(join(outputRoot, file), 'utf8'),
  })));
  const pageAtRoute = (route, marker, description) => {
    const normalizedRoute = route.replaceAll('/', sep);
    const found = pages.find(({ file, html }) => file.endsWith(normalizedRoute) && html.includes(marker));
    assert(found, `Build must emit ${description} at ${route} with rendered content ${marker}.`);
    return found;
  };

  const home = pages.find(({ file }) => file === 'index.html');
  assert(home, 'Build must emit a root home page.');
  assert(home.html.includes('Smoke Test API Reference'), 'Home page must include the configured title.');
  assert(home.html.includes('Open the API reference'), 'Home page must link into the docs.');

  const openapiPage = pageAtRoute('docs/openapi/widgets/listWidgets/index.html', '/widgets', 'native OpenAPI operation');
  assert(openapiPage.html.includes('listWidgets'), 'OpenAPI operation page must identify its operation.');
  assert.match(openapiPage.html, /GET/i, 'OpenAPI operation page must render the HTTP method.');
  assert(openapiPage.html.includes('/widgets'), 'OpenAPI operation page must render its path.');
  assert(openapiPage.html.includes('Widget'), 'OpenAPI operation page must render its response schema.');

  const asyncApiPage = pageAtRoute('docs/asyncapi/unknown/receiveWidgetCreated/index.html', 'WidgetCreated', 'native AsyncAPI operation');
  assert(asyncApiPage.html.includes('widgetId'), 'AsyncAPI operation page must render its message schema.');

  const catalogPage = pageAtRoute('docs/openapi/unknown/listCatalogItems/index.html', 'listCatalogItems', 'Catalog OpenAPI operation');
  const adminPage = pageAtRoute('docs/openapi/unknown/listAdminWidgets/index.html', 'listAdminWidgets', 'Admin OpenAPI operation');
  assert.notEqual(catalogPage.file, adminPage.file, 'Same-basename OpenAPI inputs must produce distinct routes.');

  const graphqlPage = pageAtRoute('docs/graphql/operations/query/widget/index.html', 'Operation: query', 'GraphQL query');
  assert(graphqlPage.html.includes('Type: ID!'), 'GraphQL operation page must render its argument type.');

  const docsIndex = pages.find(({ file }) => file === join('docs', 'index.html'));
  assert(docsIndex, 'Fumadocs docs landing page must be exported.');
  for (const pageTitle of ['List widgets', 'Receive Widget Created', 'GraphQL API']) {
    assert(docsIndex.html.includes(pageTitle), `Docs navigation must include ${pageTitle}.`);
  }

  const assetReferences = pages.flatMap(({ html }) =>
    [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((match) => match[1]),
  ).filter((value) => value.startsWith(`${basePath}/_next/`));
  assert(assetReferences.length > 0, 'Fumadocs assets must use the GitHub Pages base path.');
  for (const asset of assetReferences) {
    const assetPath = resolve(outputRoot, decodeURIComponent(asset.slice(basePath.length + 1)));
    assert(assetPath.startsWith(`${resolve(outputRoot)}${sep}`), `Asset URL escapes output directory: ${asset}`);
    await stat(assetPath);
  }

  console.log(`Smoke test passed: ${htmlFiles.length} Fumadocs HTML pages and ${assetReferences.length} base-path assets generated.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
