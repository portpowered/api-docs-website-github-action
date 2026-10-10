// Fumadocs emits one meta.json per input schema for shared output folders.
// Merge those inventories before its parallel writes, and reject page collisions.
export function mergeGeneratedFiles(files) {
  const unique = new Map();
  for (const file of files) {
    const previous = unique.get(file.path);
    if (!previous) {
      unique.set(file.path, { ...file });
      continue;
    }
    if (!file.path.endsWith('meta.json')) throw new Error(`Duplicate generated page: ${file.path}`);
    const left = JSON.parse(previous.content);
    const right = JSON.parse(file.content);
    if (left.title !== right.title || left.description !== right.description) {
      throw new Error(`Conflicting generated folder metadata: ${file.path}`);
    }
    previous.content = JSON.stringify({ ...left, pages: [...new Set([...left.pages, ...right.pages])] }, null, 2);
  }
  files.splice(0, files.length, ...unique.values());
}
