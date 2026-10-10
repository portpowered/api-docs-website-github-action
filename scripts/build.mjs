import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';
import { parse as parseGraphQL, Kind } from 'graphql';
import { writeSchemaPresentations } from './presentations.mjs';
import { parseJSONMediaTypes } from './json-media-types.mjs';

const actionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.resolve(process.env.API_DOCS_SOURCE || '.');
const outputRoot = path.resolve(process.env.API_DOCS_OUTPUT || 'api-docs-out');
const buildRoot = path.join(actionRoot, '.fumadocs-build');
const title = process.env.API_DOCS_TITLE?.trim() || 'API Documentation';
const basePath = (process.env.API_DOCS_BASE_PATH || '').trim().replace(/\/$/, '');
const discover = (process.env.API_DOCS_DISCOVER || 'true').toLowerCase() !== 'false';
const guidesDirectory = process.env.API_DOCS_GUIDES?.trim();
const jsonMediaTypes = parseJSONMediaTypes(process.env.API_DOCS_JSON_MEDIA_TYPES);
const schemaView = process.env.API_DOCS_SCHEMA_VIEW || 'native';
if (!['native', 'references'].includes(schemaView)) throw new Error(`Invalid schema view: ${schemaView}`);

function patterns(name) {
  return (process.env[`API_DOCS_${name}`] || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function matches(explicit, extensions) {
  const found = new Set();
  for (const pattern of explicit) {
    const paths = await fg(pattern, { cwd: sourceRoot, onlyFiles: true, unique: true, followSymbolicLinks: false });
    if (paths.length === 0) throw new Error(`Schema path or pattern did not match any files: ${pattern}`);
    for (const file of paths) found.add(file);
  }
  if (discover && explicit.length === 0) {
    for (const file of await fg(`**/*.{${extensions.join(',')}}`, {
      cwd: sourceRoot,
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
    })) found.add(file);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

async function parseStructured(file) {
  const raw = await readFile(path.resolve(sourceRoot, file), 'utf8');
  const document = /\.json$/i.test(file) ? JSON.parse(raw) : parseYaml(raw);
  if (!document || typeof document !== 'object') throw new Error(`${file} does not contain a YAML or JSON object`);
  return document;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';
}

function assertWithin(root, target, description) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${description} must be a directory inside source-directory.`);
  }
}

async function validateGuideTree(directory) {
  let hasGuidePage = false;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Guides directory cannot contain symbolic links: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      const nestedHasGuidePage = await validateGuideTree(entryPath);
      hasGuidePage ||= nestedHasGuidePage;
    }
    else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) hasGuidePage = true;
  }
  return hasGuidePage;
}

async function resolveGuidesDirectory() {
  if (!guidesDirectory) return undefined;
  if (path.isAbsolute(guidesDirectory) || path.win32.isAbsolute(guidesDirectory)) {
    throw new Error('guides-directory must be a relative directory path inside source-directory.');
  }

  const sourceRealPath = await realpath(sourceRoot);
  const guidesPath = path.resolve(sourceRoot, guidesDirectory);
  assertWithin(sourceRoot, guidesPath, 'guides-directory');
  let guidesRealPath;
  try {
    guidesRealPath = await realpath(guidesPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`Guides directory does not exist: ${guidesDirectory}`);
    }
    throw error;
  }
  assertWithin(sourceRealPath, guidesRealPath, 'guides-directory');
  if (!(await stat(guidesRealPath)).isDirectory()) {
    throw new Error(`Guides path is not a directory: ${guidesDirectory}`);
  }
  if (!(await validateGuideTree(guidesRealPath))) {
    throw new Error(`Guides directory contains no Markdown or MDX pages: ${guidesDirectory}`);
  }
  return guidesRealPath;
}

async function resolveGraphQLBindingsPath() {
  const configured = process.env.API_DOCS_GRAPHQL_BINDINGS?.trim();
  if (!configured) return undefined;
  if (path.isAbsolute(configured) || path.win32.isAbsolute(configured)) {
    throw new Error('graphql-bindings must be a relative file path inside source-directory.');
  }

  const sourceRealPath = await realpath(sourceRoot);
  const bindingPath = path.resolve(sourceRoot, configured);
  assertWithin(sourceRoot, bindingPath, 'graphql-bindings');
  let bindingRealPath;
  try {
    bindingRealPath = await realpath(bindingPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`GraphQL bindings file does not exist: ${configured}`);
    }
    throw error;
  }
  assertWithin(sourceRealPath, bindingRealPath, 'graphql-bindings');
  if (!(await stat(bindingRealPath)).isFile()) throw new Error(`GraphQL bindings path is not a file: ${configured}`);
  return bindingRealPath;
}

const openApiFiles = await matches(patterns('OPENAPI'), ['yaml', 'yml', 'json']);
const asyncApiFiles = await matches(patterns('ASYNCAPI'), ['yaml', 'yml', 'json']);
const graphqlFiles = await matches(patterns('GRAPHQL'), ['graphql', 'gql']);
const guidesSource = await resolveGuidesDirectory();
const graphqlBindingsPath = await resolveGraphQLBindingsPath();
const schemas = { openapi: [], asyncapi: [], graphql: [] };
const seen = new Set();

for (const file of openApiFiles) {
  const document = await parseStructured(file);
  if (patterns('OPENAPI').length && !document.openapi) throw new Error(`${file} is not an OpenAPI document`);
  if (document.openapi) { schemas.openapi.push(path.resolve(sourceRoot, file).replaceAll('\\', '/')); seen.add(file); }
}
for (const file of asyncApiFiles) {
  const document = await parseStructured(file);
  if (patterns('ASYNCAPI').length && !document.asyncapi) throw new Error(`${file} is not an AsyncAPI document`);
  if (document.asyncapi) { schemas.asyncapi.push(path.resolve(sourceRoot, file).replaceAll('\\', '/')); seen.add(file); }
}
for (const file of graphqlFiles) { schemas.graphql.push(path.resolve(sourceRoot, file).replaceAll('\\', '/')); seen.add(file); }

if (discover) {
  const candidates = await fg('**/*.{yaml,yml,json,graphql,gql}', { cwd: sourceRoot, onlyFiles: true, unique: true, followSymbolicLinks: false, ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'] });
  for (const file of candidates) {
    if (seen.has(file)) continue;
    try {
      if (/\.(graphql|gql)$/i.test(file)) {
        const source = await readFile(path.resolve(sourceRoot, file), 'utf8');
        if (/\b(type|schema|scalar|enum|input|interface|union|directive)\b/.test(source)) schemas.graphql.push(path.resolve(sourceRoot, file).replaceAll('\\', '/'));
        continue;
      }
      const document = await parseStructured(file);
      if (document.openapi) schemas.openapi.push(path.resolve(sourceRoot, file).replaceAll('\\', '/'));
      else if (document.asyncapi) schemas.asyncapi.push(path.resolve(sourceRoot, file).replaceAll('\\', '/'));
    } catch {
      // Discovery also scans ordinary repository YAML and JSON files.
    }
  }
}

for (const kind of Object.keys(schemas)) schemas[kind] = [...new Set(schemas[kind])].sort();
if (!Object.values(schemas).some((items) => items.length > 0)) throw new Error('No supported API schemas found. Set openapi, asyncapi, or graphql paths, or enable discover.');
const sourceFromOutput = path.relative(outputRoot, sourceRoot);
if (!sourceFromOutput || (!sourceFromOutput.startsWith(`..${path.sep}`) && sourceFromOutput !== '..' && !path.isAbsolute(sourceFromOutput))) {
  throw new Error('The output directory cannot be the source directory or one of its parent directories.');
}

await rm(buildRoot, { recursive: true, force: true });
await mkdir(path.join(buildRoot, 'content', 'docs'), { recursive: true });
await cp(path.join(actionRoot, 'template'), buildRoot, { recursive: true });
const sourceSchemas = structuredClone(schemas);
Object.assign(schemas, await writeSchemaPresentations(schemas, path.join(buildRoot, 'schemas')));
if (guidesSource) await cp(guidesSource, path.join(buildRoot, 'content', 'docs', 'guides'), { recursive: true });
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const githubRepo = process.env.GITHUB_REPOSITORY?.split('/')[1];
const resolvedBasePath = basePath || (githubRepo && !githubRepo.endsWith('.github.io') ? `/${githubRepo}` : '');
const buildConfig = {
  title,
  basePath: resolvedBasePath,
  sourceRoot: sourceRoot.replaceAll('\\', '/'),
  schemaBindings: graphqlBindingsPath?.replaceAll('\\', '/'),
  schemas,
  sourceSchemas,
  jsonMediaTypes,
  schemaView,
};
await writeFile(path.join(buildRoot, 'lib', 'site-config.json'), JSON.stringify(buildConfig, null, 2));

const { spawnSync } = await import('node:child_process');
const generate = spawnSync(process.execPath, [path.join(buildRoot, 'scripts', 'generate-docs.mjs')], { cwd: buildRoot, encoding: 'utf8', stdio: 'inherit' });
if (generate.status !== 0) throw new Error(`Fumadocs schema generation failed.\n${generate.stdout}\n${generate.stderr}`);
const build = spawnSync(process.execPath, [path.join(actionRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build', buildRoot], {
  cwd: actionRoot,
  encoding: 'utf8',
  env: { ...process.env, API_DOCS_BASE_PATH: resolvedBasePath, API_DOCS_TITLE: title },
  stdio: 'inherit',
});
if (build.status !== 0) throw new Error(`Fumadocs static build failed with exit code ${build.status}.`);
await cp(path.join(buildRoot, 'out'), outputRoot, { recursive: true });
console.log(`Generated Fumadocs API documentation in ${outputRoot}`);
