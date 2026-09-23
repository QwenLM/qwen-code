function importsConfig(node) {
  return (
    typeof node.source.value === 'string' &&
    node.source.value.endsWith('/config/config.js') &&
    node.specifiers.some(
      (specifier) =>
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === 'Config',
    )
  );
}

function isObjectCreate(node) {
  return (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object.type === 'Identifier' &&
    node.callee.object.name === 'Object' &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'create' &&
    !(node.arguments[0]?.type === 'Literal' && node.arguments[0].value === null)
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require Config prototype derivation to go through deriveConfig.',
    },
    schema: [],
    messages: {
      useDeriveConfig:
        'Do not derive Config with Object.create(). Use deriveConfig() or a specialized Config factory.',
    },
  },

  create(context) {
    let hasConfigImport = false;
    const objectCreateCalls = [];

    return {
      ImportDeclaration(node) {
        if (importsConfig(node)) hasConfigImport = true;
      },
      CallExpression(node) {
        if (isObjectCreate(node)) objectCreateCalls.push(node);
      },
      'Program:exit'() {
        if (!hasConfigImport) return;
        for (const node of objectCreateCalls) {
          context.report({ node, messageId: 'useDeriveConfig' });
        }
      },
    };
  },
};
