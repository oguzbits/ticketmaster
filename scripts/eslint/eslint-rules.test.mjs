import path from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// These tests run the project's real eslint.config.mjs, so removing a rule from the config turns
// the matching "reports" test red.
const ROOT = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: ROOT });

const SAFETY_RULE = 'local/require-safety-comment';
const MOCK_MESSAGE = 'no-module-mocking';
const UNKNOWN_PARAM_MESSAGE = 'no-unknown-parameters';
const UNKNOWN_RETURN_MESSAGE = 'no-unknown-returns';
const DICTIONARY_MESSAGE = 'no-unsafe-dictionary-type';
const WIDEN_RULE = 'local/no-widen-then-assert';
const ENV_MESSAGE = 'env-only-through-config';
const CLOCK_MESSAGE = 'injected-clock';

async function lint(code, file = 'apps/api/src/example.ts') {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return result.messages;
}

async function reported(code, marker, file) {
  const messages = await lint(code, file);
  return messages.filter((m) => m.ruleId === marker || m.message.startsWith(marker));
}

describe('env-only-through-config', () => {
  const flagged = (file) => reported('export const port = process.env.PORT;', ENV_MESSAGE, file);

  it('reports process.env in application code but not in the config module', async () => {
    expect(await flagged('apps/api/src/modules/booking/booking.service.ts')).toHaveLength(1);
    expect(await flagged('apps/worker/src/main.ts')).toHaveLength(1);
    expect(await flagged('apps/api/src/config/config.module.ts')).toEqual([]);
  });
});

describe('injected-clock', () => {
  const NONDETERMINISTIC = [
    'export const now = Date.now();',
    'export const now = new Date();',
    'export const pick = Math.random();',
    'export const id = crypto.randomUUID();',
  ];
  const flagged = (code, file) => reported(code, CLOCK_MESSAGE, file);

  it('reports clock and random access in core and module domain code', async () => {
    for (const code of NONDETERMINISTIC) {
      expect(await flagged(code, 'apps/api/src/modules/booking/domain/hold.ts')).toHaveLength(1);
      expect(await flagged(code, 'apps/api/src/core/hold.ts')).toHaveLength(1);
    }
  });

  it('allows them in adapters and domain tests, and a date built from a value in the domain', async () => {
    const [dateNow] = NONDETERMINISTIC;
    expect(await flagged(dateNow, 'apps/api/src/modules/booking/system-clock.ts')).toEqual([]);
    expect(await flagged(dateNow, 'apps/api/src/modules/booking/domain/hold.spec.ts')).toEqual([]);
    expect(
      await flagged(
        'export const at = (ms: number) => new Date(ms);',
        'apps/api/src/modules/booking/domain/hold.ts'
      )
    ).toEqual([]);
  });
});

describe('no-http-in-components', () => {
  const IMPORT = "import { HttpClient } from '@angular/common/http';\nexport const x = HttpClient;";
  const flagged = (file) => reported(IMPORT, 'no-restricted-imports', file);

  it('reports HttpClient in a component but not in a service or store', async () => {
    expect(await flagged('apps/web/src/app/events/event-list.ts')).toHaveLength(1);
    expect(await flagged('apps/web/src/app/events/event.service.ts')).toEqual([]);
    expect(await flagged('apps/web/src/app/events/event.store.ts')).toEqual([]);
  });
});

describe('local/require-safety-comment', () => {
  const flagged = (code) => reported(code, SAFETY_RULE);

  it('reports an assertion without a justification', async () => {
    expect(await flagged('export const a = JSON.parse("1") as number;\n')).toHaveLength(1);
    expect(await flagged('export const a = <number>JSON.parse("1");\n')).toHaveLength(1);
  });

  it('reports an empty or unrelated comment', async () => {
    expect(await flagged('// SAFETY:\nexport const a = JSON.parse("1") as number;\n')).toHaveLength(
      1
    );
    expect(
      await flagged('// it is a number\nexport const a = JSON.parse("1") as number;\n')
    ).toHaveLength(1);
  });

  it('accepts a SAFETY comment on the line above or on the same line', async () => {
    expect(
      await flagged(
        '// SAFETY: the config file only holds numbers\nexport const a = JSON.parse("1") as number;\n'
      )
    ).toHaveLength(0);
    expect(
      await flagged('export const a = JSON.parse("1") as number; // SAFETY: only numbers here\n')
    ).toHaveLength(0);
  });

  it('accepts as const', async () => {
    expect(await flagged('export const a = { b: 1 } as const;\n')).toHaveLength(0);
  });
});

describe('no-module-mocking', () => {
  const flagged = (code) => reported(code, MOCK_MESSAGE);

  it('reports module mocks of Vitest and Jest', async () => {
    expect(await flagged('vi.mock("./x");\n')).toHaveLength(1);
    expect(await flagged('vi.doMock("./x");\n')).toHaveLength(1);
    expect(await flagged('jest.mock("./x");\n')).toHaveLength(1);
  });

  it('allows spies and function mocks', async () => {
    expect(await flagged('export const f = vi.fn();\nvi.spyOn(console, "log");\n')).toHaveLength(0);
  });
});

describe('no-unknown-parameters', () => {
  const flagged = (code) => reported(code, UNKNOWN_PARAM_MESSAGE);

  it('reports unknown as a parameter type', async () => {
    expect(await flagged('export function f(a: unknown) { return a; }\n')).toHaveLength(1);
    expect(await flagged('export const f = (a: unknown) => a;\n')).toHaveLength(1);
    expect(await flagged('export interface P { run(payload: unknown): void }\n')).toHaveLength(1);
    expect(await flagged('export type H = (payload: unknown) => void;\n')).toHaveLength(1);
  });

  it('allows the cause convention, type predicates, catch clauses and typed parameters', async () => {
    expect(
      await flagged(
        'export class E extends Error { constructor(m: string, cause: unknown) { super(m, { cause }); } }\n'
      )
    ).toHaveLength(0);
    expect(
      await flagged(
        'export function isText(a: unknown): a is string { return typeof a === "string"; }\n'
      )
    ).toHaveLength(0);
    expect(
      await flagged(
        'export function f() { try { return 1; } catch (error: unknown) { throw error; } }\n'
      )
    ).toHaveLength(0);
    expect(await flagged('export function f(a: string) { return a; }\n')).toHaveLength(0);
  });
});

describe('no-unknown-returns', () => {
  const flagged = (code) => reported(code, UNKNOWN_RETURN_MESSAGE);

  it('reports unknown and Promise<unknown> as a return type', async () => {
    expect(await flagged('export function f(): unknown { return 1; }\n')).toHaveLength(1);
    expect(await flagged('export const f = async (): Promise<unknown> => 1;\n')).toHaveLength(1);
    expect(await flagged('export interface C { close(done: () => void): unknown }\n')).toHaveLength(
      1
    );
    expect(await flagged('export type G = () => PromiseLike<unknown>;\n')).toHaveLength(1);
  });

  it('allows void, typed and Promise<void> returns', async () => {
    expect(await flagged('export function f(): void {}\n')).toHaveLength(0);
    expect(await flagged('export const f = async (): Promise<string> => "a";\n')).toHaveLength(0);
    expect(await flagged('export const g = async (): Promise<void> => {};\n')).toHaveLength(0);
  });
});

describe('no-unsafe-dictionary-type', () => {
  const flagged = (code) => reported(code, DICTIONARY_MESSAGE);

  it('reports dictionaries whose values are unknown, any, object or {}', async () => {
    expect(await flagged('export type A = Record<string, unknown>;\n')).toHaveLength(1);
    expect(await flagged('export type A = Record<string, any>;\n')).toHaveLength(1);
    expect(await flagged('export type A = Record<string, object>;\n')).toHaveLength(1);
    expect(await flagged('export type A = Record<string, {}>;\n')).toHaveLength(1);
    expect(await flagged('export interface A { [key: string]: unknown }\n')).toHaveLength(1);
  });

  it('allows typed values, finite keys and generic constraints', async () => {
    expect(await flagged('export type A = Record<string, string>;\n')).toHaveLength(0);
    expect(await flagged('export type A = Record<"a" | "b", number>;\n')).toHaveLength(0);
    expect(
      await flagged('export function f<T extends Record<string, unknown>>(v: T): T { return v; }\n')
    ).toHaveLength(0);
  });
});

describe('local/no-widen-then-assert', () => {
  const flagged = (code) => reported(code, WIDEN_RULE);

  it('reports an assertion that narrows a const that was widened before', async () => {
    expect(
      await flagged('const a: unknown = { n: 1 };\nexport const b = a as { n: number };\n')
    ).toHaveLength(1);
    expect(
      await flagged('const a = { n: 1 } as unknown;\nexport const b = a as { n: number };\n')
    ).toHaveLength(1);
    expect(
      await flagged(
        'const a: Record<string, unknown> = { n: 1 };\nexport const b = a as { n: number };\n'
      )
    ).toHaveLength(1);
  });

  it('finds the widened const when the assertion comes earlier in the file', async () => {
    expect(
      await flagged(
        'export function read() { return a as { n: number }; }\nconst a: unknown = { n: 1 };\n'
      )
    ).toHaveLength(1);
  });

  it('allows narrowing through checks, unrelated assertions and widening targets', async () => {
    expect(await flagged('const a: unknown = 1;\nexport const b = typeof a;\n')).toHaveLength(0);
    expect(
      await flagged('declare const other: string;\nexport const b = other as "x";\n')
    ).toHaveLength(0);
    expect(await flagged('const a: unknown = 1;\nexport const b = a as unknown;\n')).toHaveLength(
      0
    );
  });
});
