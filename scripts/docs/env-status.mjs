/** Renders the kind cell (`default ...` / `optional` / `required`) of one env schema field. */
export function envStatus(schema) {
  let inner = schema;
  // Transforms wrap the schema in a ZodPipe, hiding an inner `.default(...)` from `.def.type`.
  while (inner?.def?.type === 'pipe') inner = inner.def.in;
  if (inner?.def?.type === 'default') return `default \`${inner.def.defaultValue}\``;
  return schema.isOptional() ? 'optional' : 'required';
}
