import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(repoRoot, 'tests', 'fixtures');
const tempRoot = await mkdtemp(join(tmpdir(), 'api-docs-smoke-'));
const outputRoot = join(tempRoot, 'site');

try {
  const build = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'build.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      API_DOCS_TITLE: 'Smoke Test API Reference',
      API_DOCS_OPENAPI: 'openapi.yaml,service-a/openapi.yaml,service-b/openapi.yaml',
      API_DOCS_ASYNCAPI: 'asyncapi.yaml,asyncapi3.yaml',
      API_DOCS_GRAPHQL: 'schema.graphql',
      API_DOCS_DISCOVER: 'false',
      API_DOCS_SOURCE: fixtureRoot,
      API_DOCS_OUTPUT: outputRoot,
    },
  });

  assert.equal(build.status, 0, `Build failed.\n${build.stdout}\n${build.stderr}`);
  const files = await readdir(outputRoot, { recursive: true });
  assert(files.includes('index.html'), 'Build must emit the static site at index.html.');

  const html = await readFile(join(outputRoot, 'index.html'), 'utf8');
  for (const expected of [
    'Smoke Test API Reference',
    'Sample Library HTTP API',
    'listWidgets',
    'Sample Library Catalog API',
    'listCatalogItems',
    'Sample Library Admin API',
    'listAdminWidgets',
    'Sample Library Events',
    'WidgetCreated',
    'Sample Library AsyncAPI 3',
    'receiveWidgetCreated',
    'widgetId',
    'GraphQL',
    'widget',
  ]) {
    assert(html.includes(expected), `Generated website is missing expected API content: ${expected}`);
  }

  const navigation = html.match(/<nav id="navigation">([\s\S]*?)<\/nav>/)?.[1];
  assert(navigation, 'Generated website must include schema navigation.');
  const navTargets = [...navigation.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  assert(navTargets.length > 0, 'Generated navigation must link to API sections.');
  assert.equal(new Set(navTargets).size, navTargets.length, 'Navigation anchors must be unique across documents.');
  for (const target of navTargets) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${target.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`, 'g'))].length, 1,
      `Navigation target must resolve to exactly one section: ${target}`);
  }

  assert.match(html, /<style>[\s\S]*?<\/style>/, 'Generated website must include its CSS for offline static hosting.');
  assert.match(html, /<script>[\s\S]*?<\/script>/, 'Generated website must include its behavior for offline static hosting.');

  const localAssets = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:[a-z]+:|\/\/|data:)/i.test(value));
  for (const asset of localAssets) {
    const assetPath = resolve(outputRoot, decodeURIComponent(asset.split(/[?#]/, 1)[0]));
    assert(assetPath.startsWith(`${resolve(outputRoot)}${process.platform === 'win32' ? '\\' : '/'}`),
      `Asset URL escapes output directory: ${asset}`);
    await stat(assetPath);
  }

  console.log(`Smoke test passed: ${files.length} static files generated with all three API formats.`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
