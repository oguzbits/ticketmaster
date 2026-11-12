const BROAD_KEYWORDS = new Set(['TSUnknownKeyword', 'TSAnyKeyword', 'TSObjectKeyword']);

function isBroad(type) {
  if (BROAD_KEYWORDS.has(type.type)) return true;
  if (type.type !== 'TSTypeReference' || type.typeName.name !== 'Record') return false;
  const value = type.typeArguments?.params[1];
  return value !== undefined && BROAD_KEYWORDS.has(value.type);
}

/**
 * Rejects `const a: unknown = x; ... a as Foo`: widening a known value and asserting it back
 * fabricates evidence. shortcut: same file, `const` bindings and a plain identifier on the left of
 * `as` only; flows through other variables, imports or calls are not followed.
 */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      widened:
        '`{{name}}` was widened to a broad type and is asserted back here. Keep the specific type, or parse the value with a Zod schema.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const widened = new Set();
    const assertions = [];

    function resolve(node, name) {
      for (let scope = sourceCode.getScope(node); scope; scope = scope.upper) {
        const variable = scope.set.get(name);
        if (variable) return variable;
      }
      return undefined;
    }

    return {
      VariableDeclarator(node) {
        if (node.parent.kind !== 'const' || node.id.type !== 'Identifier' || node.init === null) {
          return;
        }
        const annotation = node.id.typeAnnotation?.typeAnnotation;
        const byAnnotation = annotation !== undefined && isBroad(annotation);
        const byAssertion =
          node.init.type === 'TSAsExpression' && isBroad(node.init.typeAnnotation);
        if (byAnnotation || byAssertion) widened.add(sourceCode.getDeclaredVariables(node)[0]);
      },
      TSAsExpression(node) {
        if (node.expression.type !== 'Identifier' || isBroad(node.typeAnnotation)) return;
        assertions.push({ node, variable: resolve(node, node.expression.name) });
      },
      'Program:exit'() {
        for (const { node, variable } of assertions) {
          if (variable !== undefined && widened.has(variable)) {
            context.report({ node, messageId: 'widened', data: { name: variable.name } });
          }
        }
      },
    };
  },
};
