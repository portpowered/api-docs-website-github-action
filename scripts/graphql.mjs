import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Kind, parse, print } from 'graphql';

const namedKinds = new Set([
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
  Kind.ENUM_TYPE_DEFINITION,
  Kind.SCALAR_TYPE_DEFINITION,
  Kind.UNION_TYPE_DEFINITION,
]);

const extensionKinds = new Set([
  Kind.OBJECT_TYPE_EXTENSION,
  Kind.INTERFACE_TYPE_EXTENSION,
  Kind.INPUT_OBJECT_TYPE_EXTENSION,
  Kind.ENUM_TYPE_EXTENSION,
  Kind.SCALAR_TYPE_EXTENSION,
  Kind.UNION_TYPE_EXTENSION,
]);

const quoteYaml = (value) => JSON.stringify(String(value));
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'schema';

function escapeMdxText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/\\/g, '\\\\')
    .replace(/([`*_\[\]#])/g, '\\$1');
}

function descriptionText(node) {
  const description = node.description?.value?.trim();
  return description ? `${escapeMdxText(description)}\n\n` : '';
}

function linkForType(name, currentType, typeNames, prefix = '') {
  if (!typeNames.has(name)) return `\`${name}\``;
  const target = currentType === name ? `./${slug(name)}` : `${prefix}${slug(name)}`;
  return currentType === name ? `**${name}**` : `[${name}](${target})`;
}

function collectNamedTypes(typeNode, found = new Set()) {
  if (!typeNode) return found;
  if (typeNode.kind === Kind.NAMED_TYPE) found.add(typeNode.name.value);
  else collectNamedTypes(typeNode.type, found);
  return found;
}

function definitionTypes(node) {
  const names = new Set();
  if (node.interfaces) for (const item of node.interfaces) names.add(item.name.value);
  if (node.types) for (const item of node.types) names.add(item.name.value);
  if (node.fields) {
    for (const field of node.fields) {
      collectNamedTypes(field.type, names);
      for (const arg of field.arguments ?? []) collectNamedTypes(arg.type, names);
    }
  }
  if (node.values) for (const value of node.values) {
    for (const item of value.directives ?? []) {
      for (const arg of item.arguments ?? []) collectNamedTypes(arg.value, names);
    }
  }
  return names;
}

function fieldTypes(field) {
  const names = collectNamedTypes(field.type);
  for (const arg of field.arguments ?? []) collectNamedTypes(arg.type, names);
  return names;
}

function renderTypeLinks(names, typeNames, currentType) {
  const links = [...names]
    .filter((name) => typeNames.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => linkForType(name, currentType, typeNames, '../'));
  return links.length ? `\n\nRelated types: ${links.join(', ')}.\n` : '';
}

function renderSchemaBindings(typeName, schemaBindings) {
  const bindings = schemaBindings.filter((binding) => binding.type === typeName);
  if (!bindings.length) return '';
  const currentRoute = path.posix.join('graphql', 'types', slug(typeName));
  const currentRouteDirectory = path.posix.dirname(currentRoute);
  const sections = bindings.map((binding) => {
    const description = binding.description?.trim();
    const links = binding.targets.map((target) => {
      const targetRoute = String(target.url).replace(/^\/+/, '');
      const relativeUrl = path.posix.relative(currentRouteDirectory, targetRoute) || '.';
      return `- [${escapeMdxText(target.label)}](${relativeUrl})`;
    });
    return `### ${escapeMdxText(binding.field)}\n\n${description ? `${escapeMdxText(description)}\n\n` : ''}${links.join('\n')}`;
  });
  return `\n\n## Typed JSON schema references\n\n${sections.join('\n\n')}`;
}

function makeFrontmatter(title, description = '') {
  return `---\ntitle: ${quoteYaml(title)}\ndescription: ${quoteYaml(description)}\n---\n\n`;
}

async function writeMdx(file, title, description, body) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${makeFrontmatter(title, description)}${body}\n`, 'utf8');
}

/**
 * Generate Fumadocs MDX pages for one or more GraphQL SDL files.
 *
 * @param {string[]} files Absolute paths to SDL files.
 * @param {string} contentRoot Absolute path to the Fumadocs `content/docs` directory.
 */
export async function generateGraphQLFiles(files, contentRoot, options = {}) {
  const root = path.join(contentRoot, 'graphql');
  const parsedFiles = await Promise.all(files.map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })));
  const definitions = [];
  for (const { file, source } of parsedFiles) {
    const document = parse(source, { noLocation: false, sourceName: path.basename(file) });
    for (const node of document.definitions) {
      definitions.push({ node, file, source: print(node) });
    }
  }

  const typeDefinitions = new Map();
  const extensions = new Map();
  const schemaDefinition = definitions.find(({ node }) => node.kind === Kind.SCHEMA_DEFINITION)?.node;
  for (const entry of definitions) {
    const { node } = entry;
    if (namedKinds.has(node.kind) && node.name) {
      if (!typeDefinitions.has(node.name.value)) typeDefinitions.set(node.name.value, []);
      typeDefinitions.get(node.name.value).push(entry);
    } else if (extensionKinds.has(node.kind) && node.name) {
      if (!extensions.has(node.name.value)) extensions.set(node.name.value, []);
      extensions.get(node.name.value).push(entry);
    }
  }

  const typeNames = new Set(typeDefinitions.keys());
  const schemaBindings = options.schemaBindings ?? [];
  for (const binding of schemaBindings) {
    const entries = typeDefinitions.get(binding.type) ?? [];
    if (!entries.some(({ node }) => node.fields?.some((field) => field.name.value === binding.field))) {
      throw new Error(`GraphQL schema binding ${binding.type}.${binding.field} does not match a field in the schema.`);
    }
  }
  const operationRoots = new Map([
    ['query', 'Query'],
    ['mutation', 'Mutation'],
    ['subscription', 'Subscription'],
  ]);
  if (schemaDefinition) {
    for (const operation of schemaDefinition.operationTypes) {
      operationRoots.set(operation.operation, operation.type.name.value);
    }
  }

  const pages = [];
  for (const [name, entries] of [...typeDefinitions].sort(([a], [b]) => a.localeCompare(b))) {
    const [first] = entries;
    const related = new Set();
    for (const { node } of [...entries, ...(extensions.get(name) ?? [])]) {
      for (const target of definitionTypes(node)) if (target !== name) related.add(target);
    }
    const extra = extensions.get(name) ?? [];
    const code = [...entries, ...extra].map(({ source }) => source).join('\n\n');
    const body = `${descriptionText(first.node)}# ${name}\n\n\`\`\`graphql\n${code}\n\`\`\`${renderSchemaBindings(name, schemaBindings)}${renderTypeLinks(related, typeNames, name)}`;
    await writeMdx(path.join(root, 'types', `${slug(name)}.mdx`), name, `GraphQL ${first.node.kind.replace(/TypeDefinition$/, '').toLowerCase()} type`, body);
    pages.push(`types/${slug(name)}`);
  }

  const operationPages = [];
  for (const [operation, rootType] of operationRoots) {
    const roots = [...(typeDefinitions.get(rootType) ?? []), ...(extensions.get(rootType) ?? [])];
    for (const { node } of roots) {
      for (const field of node.fields ?? []) {
        const operationName = field.name.value;
        const dir = path.join(root, 'operations', operation);
        const related = fieldTypes(field);
        const typeLinks = [...related]
          .filter((type) => typeNames.has(type))
          .sort((a, b) => a.localeCompare(b))
          .map((type) => linkForType(type, undefined, typeNames, '../../../types/'));
        const details = [];
        if (field.arguments?.length) {
          details.push('## Arguments', '', ...field.arguments.flatMap((arg) => [
            `### ${arg.name.value}`,
            '',
            `${descriptionText(arg).trim()}${descriptionText(arg) ? '\n\n' : ''}Type: ${print(arg.type)}${[...collectNamedTypes(arg.type)].some((type) => typeNames.has(type)) ? ` (${[...collectNamedTypes(arg.type)].filter((type) => typeNames.has(type)).map((type) => linkForType(type, undefined, typeNames, '../../../types/')).join(', ')})` : ''}${arg.defaultValue ? `; default: \`${print(arg.defaultValue)}\`` : ''}`,
            '',
          ]));
        }
        const body = `${descriptionText(field)}# ${operationName}\n\nOperation: ${operation}\n\nReturn type: ${print(field.type)}${typeLinks.length ? ` (${typeLinks.join(', ')})` : ''}\n\n${details.join('\n')}## SDL\n\n\`\`\`graphql\n${print({ ...node, fields: [field] })}\n\`\`\``;
        await writeMdx(path.join(dir, `${slug(operationName)}.mdx`), operationName, `GraphQL ${operation} operation`, body);
        operationPages.push(`operations/${operation}/${slug(operationName)}`);
      }
    }
  }

  const inputNames = parsedFiles.map(({ file }) => path.basename(file)).join(', ');
  const body = `# GraphQL API\n\nGraphQL schema reference generated from ${escapeMdxText(inputNames)}.\n\n${operationPages.length ? `## Operations\n\n${operationPages.map((page) => `- [${escapeMdxText(path.basename(page))}](${page})`).join('\n')}\n\n` : ''}${pages.length ? `## Types\n\n${pages.map((page) => `- [${escapeMdxText(page.split('/').at(-1))}](${page})`).join('\n')}\n` : ''}`;
  await writeMdx(path.join(root, 'index.mdx'), 'GraphQL API', `GraphQL reference from ${inputNames}`, body);
  await writeFile(path.join(root, 'meta.json'), JSON.stringify({
    title: 'GraphQL',
    pages: ['index', ...(operationPages.length ? ['operations'] : []), ...(pages.length ? ['types'] : [])],
  }, null, 2), 'utf8');
  await mkdir(path.join(root, 'operations'), { recursive: true });
  await mkdir(path.join(root, 'types'), { recursive: true });
  await writeFile(path.join(root, 'operations', 'meta.json'), JSON.stringify({ title: 'Operations', pages: ['query', 'mutation', 'subscription'].filter((operation) => operationPages.some((page) => page.startsWith(`operations/${operation}/`))) }, null, 2), 'utf8');
  for (const operation of operationRoots.keys()) {
    const operationPageNames = operationPages
      .filter((page) => page.startsWith(`operations/${operation}/`))
      .map((page) => page.split('/').at(-1));
    if (operationPageNames.length) {
      await writeFile(path.join(root, 'operations', operation, 'meta.json'), JSON.stringify({ title: operation[0].toUpperCase() + operation.slice(1), pages: operationPageNames }, null, 2), 'utf8');
    }
  }
  await writeFile(path.join(root, 'types', 'meta.json'), JSON.stringify({ title: 'Types', pages: pages.map((page) => page.split('/').at(-1)) }, null, 2), 'utf8');
}
