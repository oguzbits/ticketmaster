import fs from 'node:fs';
import path from 'node:path';

import { IDEMPOTENCY_KEY_HEADER, type Role } from '@app/shared';
import { RequestMethod } from '@nestjs/common';
import {
  CUSTOM_ROUTE_ARGS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { UNPREFIXED_ROUTES } from '../app.setup.js';
import { ZodPipe } from '../infrastructure/http/zod.pipe.js';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../modules/auth/index.js';
import { buildOpenApi } from './build.js';
import { PUBLIC, ROUTES, SCHEMAS } from './routes.js';

interface ArgMetadata {
  pipes?: readonly unknown[];
}

interface FoundRoute {
  method: string;
  path: string;
  access: typeof PUBLIC | readonly Role[] | undefined;
  status: number;
  bodySchemas: z.ZodType[];
  headerSchemas: z.ZodType[];
  paramSchemas: z.ZodType[];
}

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PATCH]: 'patch',
};
const MODULES_DIR = path.resolve(import.meta.dirname, '../modules');
const reflector = new Reflector();

function controllerFiles(): string[] {
  return fs
    .readdirSync(MODULES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.controller.ts'))
    .map((file) => path.join(MODULES_DIR, file));
}

function zodSchemas(args: ArgMetadata[]): z.ZodType[] {
  return args
    .flatMap((arg) => arg.pipes ?? [])
    .flatMap((pipe) => (pipe instanceof ZodPipe ? [pipe.schema] : []));
}

/** The parameter decorators of one handler: Nest stores them as `<type>:<index>` keys. */
function argsOf(controller: object, handler: string): [string, ArgMetadata][] {
  const found: Record<string, ArgMetadata> | undefined = Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    controller,
    handler
  );
  return Object.entries(found ?? {});
}

function schemasOf(args: [string, ArgMetadata][], matches: (key: string) => boolean): z.ZodType[] {
  return zodSchemas(args.filter(([key]) => matches(key)).map(([, arg]) => arg));
}

async function foundRoutes(): Promise<Map<string, FoundRoute>> {
  const routes = new Map<string, FoundRoute>();
  for (const file of controllerFiles()) {
    const exports: object = await import(file);
    for (const controller of Object.values(exports)) {
      if (typeof controller !== 'function' || !Reflect.hasMetadata(PATH_METADATA, controller))
        continue;
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = controller.prototype[name];
        if (!Reflect.hasMetadata(METHOD_METADATA, handler)) continue;
        const method: number = Reflect.getMetadata(METHOD_METADATA, handler);
        const segments = [
          Reflect.getMetadata(PATH_METADATA, controller),
          Reflect.getMetadata(PATH_METADATA, handler),
        ]
          .join('/')
          .split('/')
          .filter(Boolean);
        const roles = reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
          handler,
          controller,
        ]);
        const isPublic = reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
          handler,
          controller,
        ]);
        const args = argsOf(controller, name);
        const explicitStatus: number | undefined = Reflect.getMetadata(HTTP_CODE_METADATA, handler);
        const prefix = UNPREFIXED_ROUTES.includes(segments.join('/')) ? '' : '/api';
        routes.set(`${controller.name}.${name}`, {
          method: METHODS[method] ?? `unsupported method ${method}`,
          path: `${prefix}/${segments.join('/')}`.replace(/:(\w+)/g, '{$1}'),
          access: isPublic === true ? PUBLIC : roles && roles.length > 0 ? roles : undefined,
          status: explicitStatus ?? (method === RequestMethod.POST ? 201 : 200),
          bodySchemas: schemasOf(args, (key) => key.startsWith(`${RouteParamtypes.BODY}:`)),
          paramSchemas: schemasOf(args, (key) => key.startsWith(`${RouteParamtypes.PARAM}:`)),
          // A custom parameter decorator is the only way Nest runs a pipe on a header.
          headerSchemas: schemasOf(args, (key) => key.includes(CUSTOM_ROUTE_ARGS_METADATA)),
        });
      }
    }
  }
  return routes;
}

describe('OpenAPI route table against the Nest controllers', () => {
  it('lists exactly the routes the controllers declare, with the same method and path', async () => {
    const found = await foundRoutes();
    const documented = new Map(
      Object.entries(ROUTES).map(([key, route]) => [key, `${route.method} ${route.path}`])
    );
    expect(documented).toEqual(
      new Map([...found].map(([key, route]) => [key, `${route.method} ${route.path}`]))
    );
  });

  it('documents the access of each route as the @Public and @Roles decorators set it', async () => {
    const found = await foundRoutes();
    for (const [key, route] of found) {
      expect(ROUTES[key]?.access, key).toEqual(route.access);
    }
  });

  it('documents the success status the controller answers', async () => {
    const found = await foundRoutes();
    for (const [key, route] of found) {
      expect(ROUTES[key]?.success.status, key).toBe(route.status);
    }
  });

  it('documents the body and header schemas the controllers parse, and every id parameter', async () => {
    const found = await foundRoutes();
    for (const [key, route] of found) {
      const documented = ROUTES[key];
      expect(route.bodySchemas, key).toEqual(
        documented?.body === undefined ? [] : [SCHEMAS[documented.body]]
      );
      expect(route.headerSchemas.length > 0, key).toBe(documented?.idempotencyKey === true);
      for (const schema of route.headerSchemas) {
        expect(schema, key).toBe(SCHEMAS.IdempotencyKey);
      }
      const idParams = (route.path.match(/\{/g) ?? []).length;
      expect(route.paramSchemas.length, key).toBe(idParams);
      for (const schema of route.paramSchemas) {
        expect(z.toJSONSchema(schema), key).toEqual(z.toJSONSchema(z.uuid()));
      }
    }
  });
});

describe('generated document', () => {
  const document = buildOpenApi(ROUTES, SCHEMAS);
  const text = JSON.stringify(document);

  it('is OpenAPI 3.1 and names the idempotency header of the payment route', () => {
    expect(document.openapi).toMatch(/^3\.1\./);
    const parameters = document.paths['/api/bookings/{id}/payment']?.post?.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name)).toContain(IDEMPOTENCY_KEY_HEADER);
  });

  it('resolves every $ref to a component', () => {
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/(\w+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const name of refs) expect(document.components.schemas, name).toHaveProperty(name ?? '');
  });

  it('requires the bearer token with the route role on every route that is not public', () => {
    for (const route of Object.values(ROUTES)) {
      const operation = document.paths[route.path]?.[route.method];
      if (route.access === PUBLIC) continue;
      expect(operation?.security, route.path).toEqual([{ bearerAuth: [...route.access] }]);
    }
  });
});
