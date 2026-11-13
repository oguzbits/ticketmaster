import js from '@eslint/js';
import angular from 'angular-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import noWidenThenAssert from './scripts/eslint/no-widen-then-assert.mjs';
import requireSafetyComment from './scripts/eslint/require-safety-comment.mjs';

const CODE_FILES = ['**/*.{js,mjs,cjs,ts}'];
const TEST_FILES = ['**/*.{spec,test}.{ts,mjs}', '**/testing/**'];
// Pure business logic: `src/core` and the `domain/` folder of every module.
const DOMAIN_FILES = ['apps/*/src/core/**/*.ts', 'apps/*/src/modules/*/domain/**/*.ts'];

const FUNCTION_NODES =
  ':matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression, TSDeclareFunction, TSFunctionType, TSMethodSignature, TSCallSignatureDeclaration)';

const sharedRules = [
  {
    selector: 'CatchClause[param=null]',
    message: 'catch clauses must declare an error parameter and handle or log it.',
  },
  {
    selector:
      "CallExpression[callee.object.name='JSON'][callee.property.name='parse'] > CallExpression[callee.object.name='JSON'][callee.property.name='stringify']",
    message: 'Use structuredClone(value) instead of JSON.parse(JSON.stringify(value)).',
  },
  {
    selector:
      "TSAsExpression[typeAnnotation.typeName.name!='const'][expression.type='TSAsExpression']",
    message:
      "Double type assertion ('as unknown as X') is forbidden. Use a Zod schema or a type guard.",
  },
  {
    selector: 'ExportAllDeclaration',
    message: 'Wildcard re-exports (`export * from`) are forbidden. Use explicit named exports.',
  },
  {
    selector:
      'TSTypeAliasDeclaration[typeAnnotation.type="TSTypeReference"][typeAnnotation.typeName.type="Identifier"]:not([typeAnnotation.typeArguments]):not([typeAnnotation.typeParameters]):not([typeParameters])',
    message: 'Redundant type alias (`type A = B`) is forbidden. Use the canonical type directly.',
  },
  {
    selector:
      'BinaryExpression[operator=/===|!==/] > Literal[value=/^[A-Z][A-Z0-9_]{2,}$/]:not([value=/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/])',
    message: 'Raw enum strings in comparisons are forbidden. Import the `as const` dictionary.',
  },
  {
    selector:
      "CallExpression[callee.object.name='z'][callee.property.name='literal'] > Literal[value=/^[A-Z][A-Z0-9_]{2,}$/]",
    message: 'Raw enum strings in z.literal() are forbidden. Use the `as const` dictionary.',
  },
  {
    selector:
      'CallExpression[callee.object.name=/^(vi|jest)$/][callee.property.name=/^(mock|doMock|unstable_mockModule)$/]',
    message:
      'no-module-mocking: do not replace modules in tests. Pass the dependency in (a port, a fake) or intercept the network with MSW.',
  },
  {
    // `cause` (Error cause) and the subject of a type predicate are the two accepted uses.
    selector: `${FUNCTION_NODES}[returnType.typeAnnotation.type!='TSTypePredicate'] > Identifier[name!='cause'][typeAnnotation.typeAnnotation.type='TSUnknownKeyword']`,
    message:
      'no-unknown-parameters: a parameter typed `unknown` hides the contract. Take a typed value, or parse the input with a Zod schema at the boundary.',
  },
  {
    selector: `${FUNCTION_NODES}[returnType.typeAnnotation.type='TSUnknownKeyword']`,
    message:
      'no-unknown-returns: a function returning `unknown` pushes the checking onto every caller. Return a typed value (a Zod-inferred type).',
  },
  {
    selector: `${FUNCTION_NODES}[returnType.typeAnnotation.typeName.name=/^(Promise|PromiseLike)$/][returnType.typeAnnotation.typeArguments.params.0.type='TSUnknownKeyword']`,
    message:
      'no-unknown-returns: `Promise<unknown>` pushes the checking onto every caller. Return a typed value (a Zod-inferred type).',
  },
  {
    // Not inside a generic constraint (`T extends Record<string, unknown>` stays allowed).
    selector: `TSTypeReference[typeName.name='Record'][typeArguments.params.1.type=/^TS(Unknown|Any|Object)Keyword$/]:not(TSTypeParameter > TSTypeReference)`,
    message:
      'no-unsafe-dictionary-type: a dictionary of `unknown`, `any` or `object` hides the value contract. Name the value type or use a Zod schema.',
  },
  {
    selector: `TSTypeReference[typeName.name='Record'][typeArguments.params.1.type='TSTypeLiteral'][typeArguments.params.1.members.length=0]:not(TSTypeParameter > TSTypeReference)`,
    message:
      'no-unsafe-dictionary-type: a dictionary of `{}` hides the value contract. Name the value type or use a Zod schema.',
  },
  {
    selector: `TSIndexSignature > TSTypeAnnotation > :matches(TSUnknownKeyword, TSAnyKeyword, TSObjectKeyword)`,
    message:
      'no-unsafe-dictionary-type: an index signature of `unknown`, `any` or `object` hides the value contract. Name the value type or use a Zod schema.',
  },
];

const processEnvRule = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message:
    'env-only-through-config: only the config module (src/config) reads process.env. Inject the validated config instead.',
};

const injectedClockRules = [
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now'], NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      'injected-clock: domain logic takes the current time from the injected Clock, so TTLs and expiry are testable without waiting.',
  },
  {
    selector:
      "CallExpression[callee.object.name='Math'][callee.property.name='random'], CallExpression[callee.property.name='randomUUID']",
    message: 'injected-clock: domain logic is deterministic. The caller passes random values in.',
  },
];

export default defineConfig([
  globalIgnores([
    '**/dist/**',
    '**/coverage/**',
    '**/.angular/**',
    'apps/web/playwright-report/**',
    'apps/web/test-results/**',
    '**/.claude/**',
    'reports/**',
    'pnpm-lock.yaml',
  ]),
  {
    files: CODE_FILES,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: {
      'unused-imports': unusedImports,
      'simple-import-sort': simpleImportSort,
      local: {
        rules: {
          'no-widen-then-assert': noWidenThenAssert,
          'require-safety-comment': requireSafetyComment,
        },
      },
    },
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'local/no-widen-then-assert': 'error',
      'local/require-safety-comment': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true, 'ts-nocheck': true }],
      'no-restricted-syntax': ['error', ...sharedRules],
    },
  },
  {
    // Logs are structured lines with IDs only (pino), never `console`. The environment is read in
    // one place per app.
    files: ['apps/*/src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-syntax': ['error', ...sharedRules, processEnvRule],
    },
  },
  {
    files: ['apps/*/src/config/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...sharedRules] },
  },
  {
    files: DOMAIN_FILES,
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...sharedRules, processEnvRule, ...injectedClockRules],
    },
  },
  {
    // packages/shared holds contracts only: schemas, types and `as const` dictionaries.
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...sharedRules,
        {
          selector: 'FunctionDeclaration, FunctionExpression, ClassDeclaration',
          message:
            'packages/shared has no implementation logic: only schemas, types and constants.',
        },
      ],
    },
  },
  {
    // Clean-code limits for application code. There is no suppression baseline: a violation fails.
    files: ['apps/*/src/**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      complexity: ['error', 10],
      'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-depth': ['error', 3],
      'max-params': ['error', 4],
      'no-nested-ternary': 'error',
    },
  },
  {
    files: ['apps/web/src/**/*.ts'],
    extends: [angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    languageOptions: { globals: globals.browser },
  },
  {
    // Components talk to the API through services and stores only.
    files: ['apps/web/src/**/*.ts'],
    ignores: ['**/*.service.ts', '**/*.store.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@angular/common/http',
              importNames: ['HttpClient'],
              message:
                'no-http-in-components: only services and stores (*.service.ts, *.store.ts) use HttpClient.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.html'],
    extends: [angular.configs.templateRecommended, angular.configs.templateAccessibility],
  },
]);
