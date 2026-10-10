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
const automaticOutputRoot = join(tempRoot, 'automatic-site');
const basePath = '/go-ring';
const actionVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
const reusableWorkflow = await readFile(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
assert(reusableWorkflow.includes('repository: portpowered/api-docs-website-github-action'),
  'Reusable workflow must check out the generator repository explicitly.');
assert(reusableWorkflow.includes('ref: ${{ inputs.action-ref }}'),
  'Reusable workflow must allow callers to pin an exact generator ref.');
assert(reusableWorkflow.includes('uses: ./.api-docs-action'),
  'Reusable workflow must invoke the checked-out generator source.');
assert(reusableWorkflow.includes("graphql-bindings: ${{ inputs['graphql-bindings'] }}"),
  'Reusable workflow must forward schema bindings to the composite action.');
assert(reusableWorkflow.includes(`default: v${actionVersion}`),
  'Reusable workflow default action-ref must remain on the current stable release tag.');
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

function pageRoute(file) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized === 'index.html') return `${basePath}/`;
  if (normalized.endsWith('/index.html')) return `${basePath}/${normalized.slice(0, -'index.html'.length)}`;
  return `${basePath}/${normalized}`;
}

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

async function assertInternalLinksResolve(pages, siteRoot) {
  const checked = [];
  for (const page of pages) {
    const baseUrl = new URL(pageRoute(page.file), 'https://site.invalid');
    for (const match of page.html.matchAll(/<a\b[^>]*\bhref=(?:"([^"]*)"|'([^']*)')/gi)) {
      const href = decodeHtml(match[1] ?? match[2] ?? '');
      if (!href || href.startsWith('javascript:')) continue;
      const targetUrl = new URL(href, baseUrl);
      if (targetUrl.origin !== baseUrl.origin) continue;
      const baseUrlPath = `${basePath}/`;
      assert(
        targetUrl.pathname === basePath || targetUrl.pathname.startsWith(baseUrlPath),
        `${page.file}: internal link is outside the Pages base path: ${href}`,
      );

      const relativeTarget = decodeURIComponent(targetUrl.pathname.slice(basePath.length)).replace(/^\/+/, '');
      const targetPath = resolve(siteRoot, relativeTarget);
      assert(
        targetPath === resolve(siteRoot) || targetPath.startsWith(`${resolve(siteRoot)}${sep}`),
        `${page.file}: internal link escapes the generated site: ${href}`,
      );
      const candidates = targetUrl.pathname.endsWith('/')
        ? [join(targetPath, 'index.html')]
        : [targetPath, join(targetPath, 'index.html')];
      let exists = false;
      for (const candidate of candidates) {
        try {
          if ((await stat(candidate)).isFile()) {
            exists = true;
            break;
          }
        } catch (error) {
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
        }
      }
      assert(exists, `${page.file}: internal link target does not exist: ${href}`);
      checked.push(href);
    }
  }
  return checked.length;
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
      API_DOCS_OPENAPI: 'openapi.yaml,service-a/openapi.yaml,service-b/openapi.yaml,protobuf-openapi.yaml,tp-inline-namespaces.yaml',
      API_DOCS_ASYNCAPI: 'asyncapi.yaml,asyncapi3.yaml,bridge.asyncapi.yaml',
      API_DOCS_GRAPHQL: 'schema.graphql',
      API_DOCS_GRAPHQL_BINDINGS: 'schema-bindings.yaml',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_GUIDES: 'guides',
      API_DOCS_OUTPUT: outputRoot,
      API_DOCS_JSON_MEDIA_TYPES: 'plain/text,text/plain;charset=UTF-8',
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
  assert.match(openapiPage.html, /href="\.\.\/\.\.\/schemas\/openapi\/widgetsettings"/, 'OpenAPI binding link must resolve from the operation page.');

  const protobufPage = pageAtRoute('docs/openapi/fcm/checkInFCMClient/index.html', 'checkInFCMClient', 'binary protobuf operation fallback');
  assert.match(protobufPage.html, /POST/i, 'Protobuf fallback must show the HTTP method.');
  assert(protobufPage.html.includes('/checkin'), 'Protobuf fallback must show the request path.');
  assert(protobufPage.html.includes('https://android.clients.google.com'), 'Protobuf fallback must show the server URL.');
  assert(protobufPage.html.includes('application/x-protobuf'), 'Protobuf fallback must preserve the media type.');
  assert(protobufPage.html.includes('format: binary'), 'Protobuf fallback must show the binary wire format.');
  assert.match(protobufPage.html, /href="[^"]*androidcheckinrequestwire[^"]*">AndroidCheckinRequestWire/, 'Protobuf fallback must link the request wire schema.');
  assert.match(protobufPage.html, /href="[^"]*androidcheckinresponsewire[^"]*">AndroidCheckinResponseWire/, 'Protobuf fallback must link the 200 response wire schema.');
  const nativeFcmPage = pageAtRoute('docs/openapi/fcm/registerFCMClient/index.html', 'registerFCMClient', 'native operation retained beside protobuf fallback');
  assert(nativeFcmPage.html.includes('/register'), 'Native operation must remain in the document after the binary fallback is extracted.');
  const protobufRequestPage = pageAtRoute('docs/openapi/schemas/protobuf-openapi/androidcheckinrequestwire/index.html', 'AndroidCheckinRequestWire', 'binary protobuf request component');
  const protobufResponsePage = pageAtRoute('docs/openapi/schemas/protobuf-openapi/androidcheckinresponsewire/index.html', 'AndroidCheckinResponseWire', 'binary protobuf response component');
  for (const page of [protobufRequestPage, protobufResponsePage]) {
    assert(page.html.includes('string'), 'Protobuf wire schema must retain its string type.');
    assert(page.html.includes('binary'), 'Protobuf wire schema must retain its binary format.');
  }

  const componentPage = pageAtRoute('docs/openapi/schemas/openapi/widgetsettings/index.html', 'WidgetSettings', 'bound OpenAPI component schema');
  assert(componentPage.html.includes('mode'), 'Component schema page must render the typed field.');
  assert(componentPage.html.includes('draft'), 'Component schema page must render the source example.');
  const schemaIndexPage = pageAtRoute('docs/openapi/schemas/index.html', 'Schema components', 'schema component index');
  assert.match(schemaIndexPage.html, /href="openapi\/widgetsettings"/, 'Schema index links must resolve to generated components.');

  const sysInfoPage = pageAtRoute('docs/openapi/schemas/tp-inline-namespaces/systemgetsysinfocommand/index.html', 'SystemGetSysInfoCommand', 'nested system namespace component');
  assert(sysInfoPage.html.includes('system.get_sysinfo'), 'System namespace page must show the recursive field path.');
  assert(sysInfoPage.html.includes('Yes'), 'System namespace page must show required nested fields.');
  assert(sysInfoPage.html.includes('string'), 'System namespace page must preserve the nested field type.');
  assert(sysInfoPage.html.includes('&quot;&quot;') || sysInfoPage.html.includes('""'), 'System namespace page must render the empty-string enum value.');
  const lightingPage = pageAtRoute('docs/openapi/schemas/tp-inline-namespaces/lightingcommandresult/index.html', 'LightingCommandResult', 'nested lighting namespace component');
  assert(lightingPage.html.includes('smartlife.iot.smartbulb.lightingservice.get_light_state'), 'Lighting page must render the nested get_light_state row.');
  assert(lightingPage.html.includes('smartlife.iot.smartbulb.lightingservice.transition_light_state'), 'Lighting page must render the nested transition_light_state row.');
  assert.match(lightingPage.html, /href="[^"]*lightstate[^"]*">LightState/, 'Lighting page must link its named LightState component.');
  assert.match(lightingPage.html, /href="[^"]*commandacknowledgement[^"]*">CommandAcknowledgement/, 'Lighting page must link its named CommandAcknowledgement component.');
  pageAtRoute('docs/openapi/schemas/tp-inline-namespaces/lightstate/index.html', 'LightState', 'named LightState component');
  pageAtRoute('docs/openapi/schemas/tp-inline-namespaces/commandacknowledgement/index.html', 'CommandAcknowledgement', 'named CommandAcknowledgement component');

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
  assert(asyncApiPage.html.includes('Embedded widget event JSON'), 'AsyncAPI operation page must link its embedded JSON component.');
  assert(asyncApiPage.html.includes('Widget event data schema'), 'AsyncAPI operation page must expose the bound JSON-in-string schema.');
  assert.match(asyncApiPage.html, /href="\.\.\/\.\.\/\.\.\/openapi\/schemas\/embedded-schemas\/widgeteventdata"/, 'AsyncAPI schema link must resolve from the operation page.');

  const embeddedComponentPage = pageAtRoute('docs/openapi/schemas/embedded-schemas/widgeteventdata/index.html', 'WidgetEventData', 'embedded JSON component schema');
  assert(embeddedComponentPage.html.includes('requestData'), 'Embedded component page must render request data fields.');
  assert(embeddedComponentPage.html.includes('responseData'), 'Embedded component page must render response data fields.');
  assert(embeddedComponentPage.html.includes('synthetic-relay-state'), 'Embedded component page must render its visibly synthetic nested example.');
  assert.match(embeddedComponentPage.html, /href="\.\.\/widgetrequestdata"/, 'Embedded fields must link to their named variants.');
  assert.match(embeddedComponentPage.html, /href="\.\.\/widgetresponsedata"/, 'Embedded fields must link to their named variants.');

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
  const legacyJSON = pageAtRoute('docs/openapi/widgets/registerLegacyWidget/index.html', 'plain/text', 'nonstandard JSON media operation');
  assert(legacyJSON.html.includes('legacy-widget'), 'Legacy JSON operation must render the request example.');
  assert(legacyJSON.html.includes('Content-Type'), 'Legacy JSON operation must render its actual request header.');
  const parameterizedJSON = pageAtRoute('docs/openapi/widgets/logoutWidgetSession/index.html',
    'text/plain;charset=UTF-8', 'parameterized JSON media operation');
  assert(parameterizedJSON.html.includes('synthetic-session'), 'Parameterized JSON must render the request example.');
  assert(parameterizedJSON.html.includes('Content-Type'), 'Parameterized JSON must render its request header.');
  const adminPage = pageAtRoute('docs/openapi/unknown/listAdminWidgets/index.html', 'listAdminWidgets', 'Admin OpenAPI operation');
  assert.notEqual(catalogPage.file, adminPage.file, 'Same-basename OpenAPI inputs must produce distinct routes.');

  const graphqlPage = pageAtRoute('docs/graphql/operations/query/widget/index.html', 'Operation: query', 'GraphQL query');
  assert(graphqlPage.html.includes('Type: ID!'), 'GraphQL operation page must render its argument type.');
  const graphqlInputPage = pageAtRoute('docs/graphql/types/widgetinput/index.html', 'Typed JSON schema references', 'GraphQL scalar binding');
  assert(graphqlInputPage.html.includes('WidgetSettings'), 'GraphQL type page must link the bound OpenAPI component.');
  assert.match(graphqlInputPage.html, /href="\.\.\/\.\.\/\.\.\/openapi\/schemas\/openapi\/widgetsettings"/, 'GraphQL type page link must resolve to the generated component.');
  const guidePage = pageAtRoute('docs/guides/enumerate-devices/index.html', 'Find the devices available to a cloud account.', 'native Fumadocs guide');
  assert(guidePage.html.includes('List all devices available to the account.'), 'Guide page must render its authored Markdown body.');

  const docsIndex = pages.find(({ file }) => file === join('docs', 'index.html'));
  assert(docsIndex, 'Fumadocs docs landing page must be exported.');
  for (const pageTitle of ['List widgets', 'Receive Widget Created', 'Check in an FCM client', 'Get lighting state', 'GraphQL API', 'Schema components', 'Device guides', 'Enumerate devices']) {
    assert(docsIndex.html.includes(pageTitle), `Docs navigation must include ${pageTitle}.`);
  }
  for (const operation of ['listCatalogItems', 'listAdminWidgets']) {
    assert(docsIndex.html.includes(operation), `Merged navigation must include ${operation} from every same-folder input.`);
  }

  const internalLinks = await assertInternalLinksResolve(pages, outputRoot);
  assert(internalLinks > 0, 'Smoke test must validate rendered internal links.');

  const automaticBuild = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      API_DOCS_TITLE: 'Automatic JSON schema fixture',
      API_DOCS_BASE_PATH: basePath,
      API_DOCS_OPENAPI: 'automatic-content-schema.yaml',
      API_DOCS_ASYNCAPI: '',
      API_DOCS_GRAPHQL: '',
      API_DOCS_GRAPHQL_BINDINGS: '',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_GUIDES: '',
      API_DOCS_OUTPUT: automaticOutputRoot,
    },
  });
  assert.equal(automaticBuild.status, 0, `Automatic contentSchema build failed.\n${automaticBuild.stdout}\n${automaticBuild.stderr}`);

  const automaticFiles = await listFiles(automaticOutputRoot);
  const automaticPages = await Promise.all(automaticFiles.filter((file) => file.endsWith('.html')).map(async (file) => ({
    file,
    html: await readFile(join(automaticOutputRoot, file), 'utf8'),
  })));
  const automaticOperation = automaticPages.find(({ file, html }) => file.endsWith(join('sendCloudRequest', 'index.html')) && html.includes('Embedded JSON schemas'));
  assert(automaticOperation, 'contentSchema references must create links from the operation without a binding manifest.');
  assert(automaticOperation.html.includes('RequestData'), 'Operation must link the embedded request variants.');
  assert(automaticOperation.html.includes('ResponseData'), 'Operation must link the embedded response variants.');
  const automaticRequest = automaticPages.find(({ file }) => file.endsWith(join('automatic-content-schema', 'requestdata', 'index.html')));
  assert(automaticRequest?.html.includes('Variants'), 'Automatically discovered request schema must render its variants.');
  assert(automaticRequest.html.includes('RelayStateRequest'), 'Automatically discovered request schema must link the relay-state command.');
  const automaticRelayState = automaticPages.find(({ file }) => file.endsWith(join('automatic-content-schema', 'relaystaterequest', 'index.html')));
  assert(automaticRelayState?.html.includes('relay_state'), 'Automatically discovered command schema must render nested relay_state.');
  const automaticResponse = automaticPages.find(({ file }) => file.endsWith(join('automatic-content-schema', 'responsedata', 'index.html')));
  assert(automaticResponse?.html.includes('Variants'), 'Automatically discovered response schema must render its variants.');
  assert(automaticResponse.html.includes('ResultResponse'), 'Automatically discovered response schema must link the result variant.');
  const automaticResult = automaticPages.find(({ file }) => file.endsWith(join('automatic-content-schema', 'resultvalue', 'index.html')));
  assert(automaticResult?.html.includes('value'), 'Automatically discovered result schema must render its nested value.');
  const automaticInternalLinks = await assertInternalLinksResolve(automaticPages, automaticOutputRoot);
  assert(automaticInternalLinks > 0, 'Automatic contentSchema build must validate all internal links.');

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

  console.log(`Smoke test passed: ${htmlFiles.length} Fumadocs HTML pages, ${internalLinks} internal links, ${automaticPages.length} automatic-schema pages, ${automaticInternalLinks} automatic-schema internal links, and ${assetReferences.length} base-path assets generated.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
