import { getRaw } from '@scalar/json-magic/magic-proxy';

const constraints = [
  'enum', 'const', 'nullable', 'format', 'pattern', 'default', 'example', 'examples',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems',
  'minProperties', 'maxProperties', 'additionalProperties', 'readOnly', 'writeOnly',
];

// Keep canonical conjunctions and alternatives separate. Eagerly multiplying
// oneOf/allOf branches can make a small recursive component consume gigabytes.
export function schemaReferenceGraph(root) {
  const sections = [];
  const pending = [{ key: '$root', schema: root }];
  const registered = new Set(['$root']);
  while (pending.length) {
    const { key, schema } = pending.shift();
    const rows = [];
    walk(schema, '$', false, rows, new Set(), 0);
    sections.push({ key, rows });
  }
  return sections;

  function walk(node, path, required, rows, active, depth) {
    if (depth > 64) throw new Error(`Schema nesting exceeds reference view limit at ${path}`);
    const raw = getRaw(node);
    if (typeof raw === 'boolean') {
      rows.push({ path, required, type: raw ? 'any' : 'never', description: '', constraints: {} });
      return;
    }
    if (!raw || typeof raw !== 'object') throw new Error(`Invalid schema at ${path}`);
    if (active.has(raw)) throw new Error(`Unreferenced schema cycle at ${path}`);
    const details = Object.fromEntries(constraints.filter((name) => Object.hasOwn(raw, name) &&
      (name !== 'additionalProperties' || typeof raw[name] === 'boolean')).map((name) => [name, raw[name]]));
    rows.push({
      path, required, type: raw.type ?? (raw.oneOf ? 'oneOf' : raw.anyOf ? 'anyOf' : raw.allOf ? 'allOf' : 'schema'),
      reference: raw.$ref, description: raw.description ?? '', constraints: details,
    });
    if (raw.$ref && !registered.has(raw.$ref)) {
      const target = node['$ref-value'];
      if (target === undefined) throw new Error(`Unresolved schema reference: ${raw.$ref}`);
      registered.add(raw.$ref);
      pending.push({ key: raw.$ref, schema: target });
    }
    active.add(raw);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      walk(child, `${path}.${name}`, raw.required?.includes(name) ?? false, rows, active, depth + 1);
    }
    for (const name of ['allOf', 'oneOf', 'anyOf']) {
      for (const [index, child] of (node[name] ?? []).entries()) {
        walk(child, `${path}.${name}[${index}]`, false, rows, active, depth + 1);
      }
    }
    if (node.items !== undefined) walk(node.items, `${path}[]`, false, rows, active, depth + 1);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') {
      walk(node.additionalProperties, `${path}[key]`, false, rows, active, depth + 1);
    }
    active.delete(raw);
  }
}

export function referenceAnchor(rootId, reference) {
  const identity = Array.from(reference, (character) => character.codePointAt(0).toString(16)).join('-');
  return rootId + '-component-' + identity;
}
