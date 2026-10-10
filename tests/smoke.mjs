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
const actionVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
const reusableWorkflow = await readFile(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
assert(
  reusableWorkflow.includes(`uses: portpowered/api-docs-website-github-action@v${actionVersion}`),
  'Reusable workflow must invoke the composite action at its own release version.',
);
assert(reusableWorkflow.includes('guides-directory: ${{ inputs.guides-directory }}'),
  'Reusable workflow must forward the guides directory.');

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
      API_DOCS_ASYNCAPI: 'asyncapi.yaml,asyncapi3.yaml,bridge.asyncapi.yaml',
      API_DOCS_GRAPHQL: 'schema.graphql',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_GUIDES: 'guides',
      API_DOCS_OUTPUT: outputRoot,
      API_DOCS_JSON_MEDIA_TYPES: 'plain/text',
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
  const asyncApi2Page = pageAtRoute('docs/asyncapi/unknown/publishWidgetCreated/index.html', 'WidgetCreated', 'adapted AsyncAPI 2 operation');
  assert(asyncApi2Page.html.includes('widgetId'), 'Adapted AsyncAPI 2 must render the original JSON payload.');
  for (const [id, message] of [['publish_v2_connection', 'ClientMessage'], ['subscribe_v2_connection', 'ServerMessage']]) {
    const bridge = pageAtRoute(`docs/asyncapi/unknown/${id}/index.html`, message, 'adapted protobuf bridge operation');
    const visible = bridge.html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const direction = id.startsWith('publish_') ? 'SEND' : 'RECEIVE';
    for (const marker of [direction, 'Source schema:', 'Schema format:', 'connection', 'application/x-protobuf', 'application/vnd.google.protobuf;version=2', 'bridge.proto', 'connection_request', 'notification']) {
      assert(visible.includes(marker), `Protobuf operation ${id} must visibly retain ${marker} outside serialized page data.`);
    }
  }

  const catalogPage = pageAtRoute('docs/openapi/unknown/listCatalogItems/index.html', 'listCatalogItems', 'Catalog OpenAPI operation');
  const legacyJSON = pageAtRoute('docs/openapi/widgets/registerLegacyWidget/index.html', 'plain/text', 'nonstandard JSON media operation');
  assert(legacyJSON.html.includes('legacy-widget'), 'Legacy JSON operation must render the request example.');
  assert(legacyJSON.html.includes('Content-Type'), 'Legacy JSON operation must render its actual request header.');
  const adminPage = pageAtRoute('docs/openapi/unknown/listAdminWidgets/index.html', 'listAdminWidgets', 'Admin OpenAPI operation');
  assert.notEqual(catalogPage.file, adminPage.file, 'Same-basename OpenAPI inputs must produce distinct routes.');

  const graphqlPage = pageAtRoute('docs/graphql/operations/query/widget/index.html', 'Operation: query', 'GraphQL query');
  assert(graphqlPage.html.includes('Type: ID!'), 'GraphQL operation page must render its argument type.');
  const guidePage = pageAtRoute('docs/guides/enumerate-devices/index.html', 'Find the devices available to a cloud account.', 'native Fumadocs guide');
  assert(guidePage.html.includes('List all devices available to the account.'), 'Guide page must render its authored Markdown body.');

  const docsIndex = pages.find(({ file }) => file === join('docs', 'index.html'));
  assert(docsIndex, 'Fumadocs docs landing page must be exported.');
  for (const pageTitle of ['List widgets', 'Receive Widget Created', 'GraphQL API', 'Device guides', 'Enumerate devices']) {
    assert(docsIndex.html.includes(pageTitle), `Docs navigation must include ${pageTitle}.`);
  }
  for (const operation of ['listCatalogItems', 'listAdminWidgets']) {
    assert(docsIndex.html.includes(operation), `Merged navigation must include ${operation} from every same-folder input.`);
  }

  for (const [guides, expectedMessage] of [
    ['missing-guides', 'Guides directory does not exist: missing-guides'],
    ['../outside-source', 'guides-directory must be a directory inside source-directory'],
  ]) {
    const invalidBuild = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        API_DOCS_TITLE: 'Smoke Test API Reference',
        API_DOCS_OPENAPI: 'openapi.yaml',
        API_DOCS_DISCOVER: 'false',
        API_DOCS_SOURCE: fixtureRoot,
        API_DOCS_GUIDES: guides,
        API_DOCS_OUTPUT: outputRoot,
      },
    });
    assert.notEqual(invalidBuild.status, 0, `Build must reject invalid guides-directory value ${guides}.`);
    assert(
      `${invalidBuild.stdout}\n${invalidBuild.stderr}`.includes(expectedMessage),
      `Invalid guides-directory value ${guides} must explain ${expectedMessage}.`,
    );
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
  const invalidMedia = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, API_DOCS_JSON_MEDIA_TYPES: 'plain/text; charset=utf-8' },
  });
  assert.notEqual(invalidMedia.status, 0, 'Configured media aliases must be bare media types.');
  assert(`${invalidMedia.stdout}\n${invalidMedia.stderr}`.includes('Invalid JSON media type'),
    'Invalid aliases must fail before generating the site.');
  const referenceOutput = join(tempRoot, 'reference-site');
  const referenceBuild = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot, encoding: 'utf8', timeout: 180_000,
    env: {
      ...process.env, API_DOCS_SOURCE: fixtureRoot, API_DOCS_OPENAPI: 'references.openapi.yaml',
      API_DOCS_ASYNCAPI: '', API_DOCS_GRAPHQL: '', API_DOCS_DISCOVER: 'false',
      API_DOCS_SCHEMA_VIEW: 'references', API_DOCS_OUTPUT: referenceOutput, API_DOCS_BASE_PATH: basePath,
    },
  });
  assert.equal(referenceBuild.status, 0, `Reference graph export failed.\n${referenceBuild.stdout}\n${referenceBuild.stderr}`);
  const graphHTML = await readFile(join(referenceOutput, 'docs/openapi/unknown/modifyRecursiveRecord/index.html'), 'utf8');
  for (const field of ['revision', 'title', 'deleted', 'oneOf', 'allOf', 'Yes']) {
    assert(graphHTML.includes(field), `Reference graph must render canonical variant/required field ${field}.`);
  }
  assert(graphHTML.includes('synthetic-record'), 'The generated request snippet must keep the schema example.');
  assert(graphHTML.includes('-component-'), 'Named components must have rendered anchor destinations.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
