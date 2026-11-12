/** @type {import('dependency-cruiser').IConfiguration} */
const TEST_FILE = '(\\.(spec|test)\\.ts$|/testing/)';
const SERVER_APPS = '^apps/(api|worker)/';
// Pure business logic: `src/core` and the `domain/` folder of every module.
const DOMAIN = '^apps/(api|worker)/src/(core|modules/[^/]+/domain)/';
const MODULE = '^apps/(api|worker)/src/modules/([^/]+)/';
const MODULE_PUBLIC_INTERFACE = '^apps/(api|worker)/src/modules/[^/]+/index\\.ts$';

module.exports = {
  forbidden: [
    {
      name: 'shared-imports-nothing-internal',
      comment: 'packages/shared is a leaf: it must not import from apps/*',
      severity: 'error',
      from: { path: '^packages/shared/src' },
      to: { path: '^apps/' },
    },
    {
      name: 'shared-only-depends-on-zod',
      comment:
        'packages/shared holds contracts only: no Node core modules, npm only zod (tests excepted)',
      severity: 'error',
      from: { path: '^packages/shared/src', pathNot: TEST_FILE },
      to: {
        dependencyTypes: ['core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg'],
        pathNot: ['node_modules/zod/', '^packages/shared/'],
      },
    },
    {
      name: 'server-not-web',
      comment: 'apps/api and apps/worker must not import from apps/web',
      severity: 'error',
      from: { path: SERVER_APPS },
      to: { path: '^apps/web/' },
    },
    {
      name: 'api-not-worker',
      comment: 'The worker builds on the API modules, never the other way round',
      severity: 'error',
      from: { path: '^apps/api/' },
      to: { path: '^apps/worker/' },
    },
    {
      name: 'web-not-server',
      comment:
        'apps/web must not import runtime code from apps/api or apps/worker. Contracts come from packages/shared.',
      severity: 'error',
      from: { path: '^apps/web/src' },
      to: { path: SERVER_APPS, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'web-no-node-core',
      comment: 'apps/web runs in the browser: no Node core modules',
      severity: 'error',
      from: { path: '^apps/web/src', pathNot: TEST_FILE },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-is-pure',
      comment:
        'Domain logic is pure and deterministic: it imports only other domain code, packages/shared and zod. No NestJS, database, Redis, queue or Node core module.',
      severity: 'error',
      from: { path: DOMAIN, pathNot: TEST_FILE },
      to: { pathNot: [DOMAIN, '^packages/shared/', 'node_modules/zod/'] },
    },
    {
      name: 'modules-only-through-public-interface',
      comment: 'A module imports another module only through its index.ts, never a file inside it',
      severity: 'error',
      from: { path: MODULE },
      to: {
        path: '^apps/(api|worker)/src/modules/[^/]+/',
        pathNot: ['^apps/$1/src/modules/$2/', MODULE_PUBLIC_INTERFACE],
      },
    },
    {
      name: 'module-internals-are-private',
      comment:
        'Code outside the modules (app module, entry points, the worker) reaches a module only through its index.ts',
      severity: 'error',
      from: { path: '^apps/', pathNot: MODULE },
      to: {
        path: '^apps/(api|worker)/src/modules/[^/]+/',
        pathNot: MODULE_PUBLIC_INTERFACE,
      },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: '^(apps|packages)/[^/]+/(dist|coverage|\\.angular)/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
    },
  },
};
