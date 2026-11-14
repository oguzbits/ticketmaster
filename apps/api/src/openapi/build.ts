/**
 * Turns the route table and the shared schemas into the OpenAPI 3.1 document
 * `docs/api/openapi.json` (`pnpm docs:generate`). The table and the schemas come in as arguments
 * so this file imports only packages (Node runs it directly, see `scripts/docs/generate.mjs`).
 */

import { IDEMPOTENCY_KEY_HEADER } from '@app/shared';
import { z } from 'zod';

import type { ErrorDoc, ErrorStatus, RouteDoc, SchemaName } from './routes.js';

type Schemas = Record<SchemaName, z.ZodType>;
type Io = 'input' | 'output';

interface JsonSchema {
  [keyword: string]: string | number | boolean | JsonSchema | JsonSchema[] | string[] | undefined;
}

interface Parameter {
  name: string;
  in: 'path' | 'header';
  required: true;
  description: string;
  schema: JsonSchema;
}

interface ResponseDoc {
  description: string;
  headers?: Record<string, { description: string; schema: JsonSchema }>;
  content?: Record<string, { schema: JsonSchema; 'x-events'?: Record<string, JsonSchema> }>;
}

interface Operation {
  operationId: string;
  summary: string;
  parameters: Parameter[];
  requestBody?: { required: true; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, ResponseDoc>;
  security: Record<string, string[]>[];
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, Partial<Record<RouteDoc['method'], Operation>>>;
  components: {
    securitySchemes: Record<string, JsonSchema>;
    schemas: Record<string, JsonSchema>;
  };
}

const JSON_TYPE = 'application/json';
const SSE_TYPE = 'text/event-stream';
const BEARER = 'bearerAuth';
const ERROR = 'Error';
const VALIDATION_ERROR = 'ValidationError';

/** The shapes Nest answers with; they are not contracts of `packages/shared`. */
const ERROR_SCHEMAS: Record<string, JsonSchema> = {
  [ERROR]: {
    type: 'object',
    properties: {
      statusCode: { type: 'integer' },
      message: { type: 'string' },
      error: { type: 'string' },
    },
    required: ['statusCode', 'message'],
  },
  [VALIDATION_ERROR]: {
    type: 'object',
    description: 'The paths of the invalid fields, never their values.',
    properties: {
      statusCode: { type: 'integer' },
      message: { type: 'string' },
      issues: { type: 'array', items: { type: 'string' } },
      error: { type: 'string' },
    },
    required: ['statusCode', 'message', 'issues'],
  },
};

const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

/** Drops the draft marker, which belongs to a standalone schema only. */
function standalone(schema: z.ZodType, io: Io): JsonSchema {
  const { $schema: _draft, ...rest } = z.toJSONSchema(schema, { io });
  // SAFETY: z.toJSONSchema emits plain JSON (strings, numbers, booleans, arrays, objects).
  return rest as JsonSchema;
}

/** Component schemas of the named shared schemas; nested named schemas become `$ref`s. */
function components(names: Set<SchemaName>, schemas: Schemas, io: Io): Record<string, JsonSchema> {
  const registry = z.registry<{ id: string }>();
  for (const name of names) registry.add(schemas[name], { id: name });
  const converted = z.toJSONSchema(registry, { io, uri: (id) => `#/components/schemas/${id}` });
  return Object.fromEntries(
    Object.entries(converted.schemas).map(([name, { $id: _id, $schema: _draft, ...rest }]) => [
      name,
      // SAFETY: z.toJSONSchema emits plain JSON (strings, numbers, booleans, arrays, objects).
      rest as JsonSchema,
    ])
  );
}

function parameters(route: RouteDoc, schemas: Schemas): Parameter[] {
  const path = [...route.path.matchAll(/\{(\w+)\}/g)].map(([, name]): Parameter => ({
    name: name ?? '',
    in: 'path',
    required: true,
    description: 'A UUID.',
    schema: standalone(z.uuid(), 'input'),
  }));
  if (!route.idempotencyKey) return path;
  const header: Parameter = {
    name: IDEMPOTENCY_KEY_HEADER,
    in: 'header',
    required: true,
    description:
      'A random UUID the client generates for each payment attempt and repeats only to retry that attempt.',
    schema: standalone(schemas.IdempotencyKey, 'input'),
  };
  return [...path, header];
}

function successResponse({ description, schema, stream }: RouteDoc['success']): ResponseDoc {
  if (stream === undefined) {
    // No schema: no body (204) or a body that is not JSON (the ticket PDF).
    if (schema === undefined) return { description };
    return { description, content: { [JSON_TYPE]: { schema: ref(schema) } } };
  }
  const events = Object.entries(stream).map(([event, name]) => [event, ref(name)]);
  const content = { schema: { type: 'string' }, 'x-events': Object.fromEntries(events) };
  return { description, content: { [SSE_TYPE]: content } };
}

function errorResponse(doc: ErrorDoc, fallback: string): ResponseDoc {
  const { description, schema } = typeof doc === 'string' ? { description: doc } : doc;
  return { description, content: { [JSON_TYPE]: { schema: ref(schema ?? fallback) } } };
}

/** The statuses every route can answer, from its auth and its input, then the table's own. */
function errorStatuses(route: RouteDoc): Partial<Record<ErrorStatus, ErrorDoc>> {
  const derived: Partial<Record<ErrorStatus, ErrorDoc>> = { 429: 'Rate limit exceeded.' };
  if (Array.isArray(route.access)) {
    derived[401] = 'Missing or invalid bearer token.';
    derived[403] = 'The token carries none of the required roles.';
  } else {
    derived[401] = 'The bearer token that was sent is invalid.';
  }
  if (route.body || route.idempotencyKey || route.path.includes('{')) {
    derived[400] = 'Invalid request.';
  }
  return { ...derived, ...route.errors };
}

function responses(route: RouteDoc): Record<string, ResponseDoc> {
  const result: Record<string, ResponseDoc> = {
    [route.success.status]: successResponse(route.success),
  };
  for (const [status, doc] of Object.entries(errorStatuses(route))) {
    result[status] = errorResponse(doc, status === '400' ? VALIDATION_ERROR : ERROR);
  }
  const limited = result['429'];
  if (limited) {
    limited.headers = {
      'Retry-After': { description: 'Seconds until the window ends.', schema: { type: 'integer' } },
    };
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => Number(a) - Number(b)));
}

function security(route: RouteDoc): Record<string, string[]>[] {
  if (Array.isArray(route.access)) return [{ [BEARER]: [...route.access] }];
  return route.optionalToken ? [{}, { [BEARER]: [] }] : [];
}

function operation(key: string, route: RouteDoc, schemas: Schemas): Operation {
  const requestBody = route.body
    ? { required: true as const, content: { [JSON_TYPE]: { schema: ref(route.body) } } }
    : undefined;
  return {
    operationId: key.replace('.', '_'),
    summary: route.summary,
    parameters: parameters(route, schemas),
    ...(requestBody && { requestBody }),
    responses: responses(route),
    security: security(route),
  };
}

function schemaNames(routes: RouteDoc[]): { request: Set<SchemaName>; response: Set<SchemaName> } {
  const request = routes.flatMap((route) => (route.body ? [route.body] : []));
  const response = routes.flatMap(({ success, errors }) => [
    ...(success.schema ? [success.schema] : []),
    ...Object.values(success.stream ?? {}),
    ...Object.values(errors ?? {}).flatMap((doc) => (typeof doc === 'string' ? [] : [doc.schema])),
  ]);
  return { request: new Set(request), response: new Set(response) };
}

export function buildOpenApi(routes: Record<string, RouteDoc>, schemas: Schemas): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  for (const [key, route] of Object.entries(routes)) {
    paths[route.path] = { ...paths[route.path], [route.method]: operation(key, route, schemas) };
  }
  const names = schemaNames(Object.values(routes));
  return {
    openapi: '3.1.0',
    info: {
      title: 'ticketmaster-klon API',
      version: '0.0.0',
      description:
        'REST API of ticketmaster-klon, generated from the route table in `apps/api/src/openapi` and the Zod schemas of `packages/shared`. Unofficial, not affiliated with any ticket vendor. Behavior beyond the schemas is described in docs/api/rest.md.',
    },
    paths,
    components: {
      securitySchemes: {
        [BEARER]: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'An access token of the Keycloak realm. The roles listed in a route’s security requirement are alternatives: one of them is enough.',
        },
      },
      schemas: {
        ...components(names.request, schemas, 'input'),
        ...components(names.response, schemas, 'output'),
        ...ERROR_SCHEMAS,
      },
    },
  };
}
