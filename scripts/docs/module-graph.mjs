/**
 * The module graph of the backend as a Mermaid flowchart, built from the JSON output of
 * dependency-cruiser. One node per API module, `infrastructure`, `core` and the worker; one edge
 * per dependency between two of them. Specs and test support are left out. Pure, so it is
 * testable; `pnpm docs:generate` writes it into docs/architecture.md.
 */

const MODULE = /^apps\/api\/src\/modules\/([^/]+)\//;
const API_LAYER = /^apps\/api\/src\/(infrastructure|core)\//;
const WORKER = /^apps\/worker\/src\//;
const NOT_PRODUCTION = /\.spec\.ts$|\/testing\//;

/** The node a source file belongs to, or null for files the graph does not show. */
export function nodeOf(source) {
  if (NOT_PRODUCTION.test(source)) return null;
  const module = MODULE.exec(source);
  if (module) return { kind: 'module', name: module[1] };
  const layer = API_LAYER.exec(source);
  if (layer) return { kind: 'layer', name: layer[1] };
  return WORKER.test(source) ? { kind: 'worker', name: 'worker' } : null;
}

const id = (node) => node.name.replaceAll('-', '_');

/** @param {{ modules: { source: string, dependencies: { resolved: string }[] }[] }} cruise */
export function moduleGraph(cruise) {
  const nodes = new Map();
  const edges = new Set();
  for (const { source, dependencies } of cruise.modules) {
    const from = nodeOf(source);
    if (from === null) continue;
    nodes.set(from.name, from);
    for (const { resolved } of dependencies) {
      const to = nodeOf(resolved);
      if (to === null || to.name === from.name) continue;
      nodes.set(to.name, to);
      edges.add(`${id(from)} --> ${id(to)}`);
    }
  }
  const named = (kind) =>
    [...nodes.values()]
      .filter((node) => node.kind === kind)
      .map((node) => node.name)
      .sort()
      .map((name) => `${id({ name })}["${name}"]`);
  return [
    'flowchart LR',
    '  worker["worker"]',
    '  subgraph api["apps/api"]',
    '    subgraph modules["modules"]',
    ...named('module').map((line) => `      ${line}`),
    '    end',
    ...named('layer').map((line) => `    ${line}`),
    '  end',
    ...[...edges].sort().map((edge) => `  ${edge}`),
  ].join('\n');
}

/**
 * The source file behind an import of the API package, from its `exports` map
 * (`@app/api/bookings` -> dist/modules/bookings/index.js -> apps/api/src/modules/bookings/index.ts),
 * or null for a specifier that is not an export. dependency-cruiser does not resolve these.
 */
export function apiSourceOf(specifier, exportsMap) {
  const entry = exportsMap[specifier.replace(/^@app\/api/, '.')];
  const built = typeof entry === 'object' ? entry.default : undefined;
  if (built === undefined) return null;
  return `apps/api/src/${built.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts')}`;
}
