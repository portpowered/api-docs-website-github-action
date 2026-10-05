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
      API_DOCS_ASYNCAPI: 'asyncapi.yaml,asyncapi3.yaml',
      API_DOCS_GRAPHQL: 'schema.graphql',
      API_DOCS_GRAPHQL_BINDINGS: 'schema-bindings.yaml',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_GUIDES: 'guides',
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
  assert(openapiPage.html.includes('Related typed widget settings'), 'OpenAPI operation page must link its bound component schema.');
  assert.match(openapiPage.html, /href="\.\.\/schemas\/openapi\/widgetsettings"/, 'OpenAPI binding link must resolve from the operation page.');

  const componentPage = pageAtRoute('docs/openapi/schemas/openapi/widgetsettings/index.html', 'WidgetSettings', 'bound OpenAPI component schema');
  assert(componentPage.html.includes('mode'), 'Component schema page must render the typed field.');
  assert(componentPage.html.includes('draft'), 'Component schema page must render the source example.');
  const schemaIndexPage = pageAtRoute('docs/openapi/schemas/index.html', 'Schema components', 'schema component index');
  assert.match(schemaIndexPage.html, /href="\.\/schemas\/openapi\/widgetsettings"/, 'Schema index links must resolve to generated components.');

  const asyncApiPage = pageAtRoute('docs/asyncapi/unknown/receiveWidgetCreated/index.html', 'WidgetCreated', 'native AsyncAPI operation');
  assert(asyncApiPage.html.includes('widgetId'), 'AsyncAPI operation page must render its message schema.');
  assert(asyncApiPage.html.includes('Embedded widget event JSON'), 'AsyncAPI operation page must link its embedded JSON component.');
  assert(asyncApiPage.html.includes('Widget event data schema'), 'AsyncAPI operation page must expose the bound JSON-in-string schema.');
  assert.match(asyncApiPage.html, /href="\.\.\/\.\.\/openapi\/schemas\/embedded-schemas\/widgeteventdata"/, 'AsyncAPI schema link must resolve from the operation page.');

  const embeddedComponentPage = pageAtRoute('docs/openapi/schemas/embedded-schemas/widgeteventdata/index.html', 'WidgetEventData', 'embedded JSON component schema');
  assert(embeddedComponentPage.html.includes('requestData'), 'Embedded component page must render request data fields.');
  assert(embeddedComponentPage.html.includes('responseData'), 'Embedded component page must render response data fields.');
  assert(embeddedComponentPage.html.includes('synthetic-relay-state'), 'Embedded component page must render its visibly synthetic nested example.');
  assert.match(embeddedComponentPage.html, /href="widgetrequestdata"/, 'Embedded fields must link to their named variants.');
  assert.match(embeddedComponentPage.html, /href="widgetresponsedata"/, 'Embedded fields must link to their named variants.');

  const embeddedRequestPage = pageAtRoute('docs/openapi/schemas/embedded-schemas/widgetrequestdata/index.html', 'RelayStateRequest', 'request-data variants');
  assert(embeddedRequestPage.html.includes('Variants'), 'Request-data page must show its schema alternatives.');
  assert(embeddedRequestPage.html.includes('SyntheticRequest'), 'Request-data page must list the synthetic alternative.');
  const relayStatePage = pageAtRoute('docs/openapi/schemas/embedded-schemas/relaystaterequest/index.html', 'relay_state', 'nested relay state request fields');
  assert(relayStatePage.html.includes('relay_state'), 'Relay-state schema page must render its nested field.');

  const embeddedResponsePage = pageAtRoute('docs/openapi/schemas/embedded-schemas/widgetresponsedata/index.html', 'ResultResponse', 'response-data variants');
  assert(embeddedResponsePage.html.includes('Variants'), 'Response-data page must show its schema alternatives.');
  const resultResponsePage = pageAtRoute('docs/openapi/schemas/embedded-schemas/resultresponse/index.html', 'result', 'nested result response');
  assert(resultResponsePage.html.includes('ResultValue'), 'Result response must link its nested result value schema.');
  const resultValuePage = pageAtRoute('docs/openapi/schemas/embedded-schemas/resultvalue/index.html', 'value', 'nested result value field');
  assert(resultValuePage.html.includes('value'), 'Result schema must render its nested value field.');

  const catalogPage = pageAtRoute('docs/openapi/unknown/listCatalogItems/index.html', 'listCatalogItems', 'Catalog OpenAPI operation');
  const adminPage = pageAtRoute('docs/openapi/unknown/listAdminWidgets/index.html', 'listAdminWidgets', 'Admin OpenAPI operation');
  assert.notEqual(catalogPage.file, adminPage.file, 'Same-basename OpenAPI inputs must produce distinct routes.');

  const graphqlPage = pageAtRoute('docs/graphql/operations/query/widget/index.html', 'Operation: query', 'GraphQL query');
  assert(graphqlPage.html.includes('Type: ID!'), 'GraphQL operation page must render its argument type.');
  const graphqlInputPage = pageAtRoute('docs/graphql/types/widgetinput/index.html', 'Typed JSON schema references', 'GraphQL scalar binding');
  assert(graphqlInputPage.html.includes('WidgetSettings'), 'GraphQL type page must link the bound OpenAPI component.');
  assert.match(graphqlInputPage.html, /href="\.\.\/\.\.\/openapi\/schemas\/openapi\/widgetsettings"/, 'GraphQL type page link must resolve to the generated component.');
  const guidePage = pageAtRoute('docs/guides/enumerate-devices/index.html', 'Find the devices available to a cloud account.', 'native Fumadocs guide');
  assert(guidePage.html.includes('List all devices available to the account.'), 'Guide page must render its authored Markdown body.');

  const docsIndex = pages.find(({ file }) => file === join('docs', 'index.html'));
  assert(docsIndex, 'Fumadocs docs landing page must be exported.');
  for (const pageTitle of ['List widgets', 'Receive Widget Created', 'GraphQL API', 'Schema components', 'Device guides', 'Enumerate devices']) {
    assert(docsIndex.html.includes(pageTitle), `Docs navigation must include ${pageTitle}.`);
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
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
