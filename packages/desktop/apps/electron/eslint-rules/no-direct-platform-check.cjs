/**
 * ESLint Rule: no-direct-platform-check
 *
 * Prevents direct access to navigator.platform. Use the platform utilities instead:
 *
 *   import { isMac, isWindows, isLinux, PATH_SEP } from '@/lib/platform'
 *
 * This ensures consistent platform detection across the codebase and proper
 * handling of path separators on different operating systems.
 *
 * Bad:
 *   navigator.platform.toLowerCase().includes('mac')
 *   navigator.platform.toUpperCase().indexOf('MAC') >= 0
 *
 * Good:
 *   import { isMac } from '@/lib/platform'
 *   if (isMac) { ... }
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct access to navigator.platform',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noDirectAccess:
        "Don't access 'navigator.platform' directly. Import from '@/lib/platform' instead: { isMac, isWindows, isLinux, PATH_SEP }",
    },
    schema: [],
  },

  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === 'Identifier' &&
          node.object.name === 'navigator' &&
          node.property.type === 'Identifier' &&
          node.property.name === 'platform'
        ) {
          // Allow in platform.ts itself (the source of truth)
          const filename = context.filename || context.getFilename()
          if (filename.includes('platform.ts')) {
            return
          }

          context.report({
            node,
            messageId: 'noDirectAccess',
          })
        }
      },
    }
  },
}
