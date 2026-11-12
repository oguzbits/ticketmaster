const MARKER = /\bSAFETY:\s*\S/;

/** A type assertion (`as T`, `<T>x`, not `as const`) needs a `SAFETY: <invariant>` comment. */
export default {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      missing:
        'Type assertion without evidence. Add a `// SAFETY: <why this cannot be wrong>` comment on the line above or at the end of the line, or parse the value with a Zod schema.',
    },
  },
  create(context) {
    const comments = context.sourceCode.getAllComments();

    function isJustified(node) {
      const first = node.loc.start.line;
      const last = node.loc.end.line;
      return comments.some(
        (comment) =>
          MARKER.test(comment.value) &&
          (comment.loc.end.line === first - 1 ||
            (comment.loc.start.line >= first && comment.loc.start.line <= last))
      );
    }

    function check(node) {
      if (!isJustified(node)) context.report({ node, messageId: 'missing' });
    }

    return {
      TSAsExpression(node) {
        const isConst =
          node.typeAnnotation.type === 'TSTypeReference' &&
          node.typeAnnotation.typeName.name === 'const';
        if (!isConst) check(node);
      },
      TSTypeAssertion: check,
    };
  },
};
