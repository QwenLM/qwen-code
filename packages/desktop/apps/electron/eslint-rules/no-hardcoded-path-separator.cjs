/**
 * ESLint Rule: no-hardcoded-path-separator
 *
 * Prevents hardcoded path separators in path comparison operations.
 * This catches patterns like `path.startsWith(dir + '/')` which fail on Windows.
 *
 * Bad:
 *   filePath.startsWith(dir + '/')
 *   path.startsWith(prefix + '/')
 *
 * Good:
 *   import { pathStartsWith } from '@craft-agent/core/utils'
 *   pathStartsWith(filePath, dir)
 *
 * Or in Node.js main process:
 *   import { sep } from 'path'
 *   filePath.startsWith(dir + sep)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow hardcoded path separators in path operations',
      category: 'Cross-Platform',
      recommended: true,
    },
    messages: {
      hardcodedSeparator:
        "Avoid hardcoded '/' or '\\\\' in path operations - this breaks on Windows/Unix. " +
        "Use pathStartsWith() from @craft-agent/core/utils, or path.sep in Node.js code.",
    },
    schema: [],
  },

  create(context) {
    return {
      BinaryExpression(node) {
        // Detect: someVar + '/' or someVar + '\\'
        if (
          node.operator === '+' &&
          node.right.type === 'Literal' &&
          (node.right.value === '/' || node.right.value === '\\')
        ) {
          // Check if parent is a path operation (startsWith, endsWith, includes)
          const parent = node.parent
          if (parent?.type === 'CallExpression') {
            const callee = parent.callee
            if (
              callee?.type === 'MemberExpression' &&
              callee.property?.type === 'Identifier' &&
              ['startsWith', 'endsWith', 'includes'].includes(callee.property.name)
            ) {
              context.report({
                node,
                messageId: 'hardcodedSeparator',
              })
            }
          }
        }
      },
    }
  },
}
