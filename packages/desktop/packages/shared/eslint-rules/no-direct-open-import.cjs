/**
 * ESLint Rule: no-direct-open-import
 *
 * Prevents importing 'open' package directly.
 * The 'open' package is ESM-only and causes issues when bundled with esbuild
 * for Electron due to ESM/CJS interop problems.
 *
 * Use the centralized openUrl() from utils/open-url.ts instead, which handles
 * the dynamic import and ESM/CJS interop correctly.
 *
 * Allowed in:
 *   - open-url.ts (the centralized wrapper)
 *
 * Bad:
 *   import open from 'open'
 *   const open = await import('open')
 *
 * Good:
 *   import { openUrl } from '../utils/open-url.ts'
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Disallow direct imports of 'open' package. Use openUrl from utils instead.",
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noDirectOpenImport:
        "Do not import 'open' directly. Use openUrl() from '../utils/open-url.ts' instead. Direct imports cause ESM/CJS interop issues in bundled Electron code.",
    },
    schema: [],
  },

  create(context) {
    // Allow the centralized wrapper file to import 'open'
    const filename = context.filename || context.getFilename()
    const basename = filename.split('/').pop() || ''
    if (basename === 'open-url.ts') {
      return {}
    }

    return {
      // Match: import open from 'open' or import { default as open } from 'open'
      ImportDeclaration(node) {
        if (node.source.value === 'open') {
          context.report({
            node,
            messageId: 'noDirectOpenImport',
          })
        }
      },

      // Match: import('open') - dynamic import
      ImportExpression(node) {
        if (node.source.type === 'Literal' && node.source.value === 'open') {
          context.report({
            node,
            messageId: 'noDirectOpenImport',
          })
        }
      },

      // Match: require('open')
      CallExpression(node) {
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length > 0 &&
          node.arguments[0].type === 'Literal' &&
          node.arguments[0].value === 'open'
        ) {
          context.report({
            node,
            messageId: 'noDirectOpenImport',
          })
        }
      },
    }
  },
}
