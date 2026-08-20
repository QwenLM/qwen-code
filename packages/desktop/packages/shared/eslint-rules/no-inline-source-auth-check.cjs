/**
 * ESLint Rule: no-inline-source-auth-check
 *
 * Prevents inline checks of source.config.isAuthenticated.
 * Use the centralized isSourceUsable() helper instead.
 *
 * The isSourceUsable() helper correctly handles:
 * - Sources with authType: 'none' (no auth required)
 * - Sources with undefined authType (no auth required)
 * - Sources with OAuth/Bearer auth (requires isAuthenticated)
 *
 * Inline checks often miss the authType: 'none' case, causing bugs where
 * no-auth sources are incorrectly filtered out.
 *
 * Allowed in:
 *   - storage.ts (where isSourceUsable is defined)
 *   - credential-manager.ts (state-setting operations, inverse check)
 *   - server-builder.ts (documented exceptions for OAuth providers)
 *
 * Bad:
 *   source.config.isAuthenticated
 *   s.config.enabled && s.config.isAuthenticated
 *
 * Good:
 *   isSourceUsable(source)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow inline source.config.isAuthenticated checks. Use isSourceUsable() from storage.ts instead.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      useIsSourceUsable:
        'Do not check source.config.isAuthenticated directly. Use isSourceUsable() from sources/storage.ts instead. ' +
        'Direct checks often miss sources with authType: "none" which should be considered authenticated.',
    },
    schema: [],
  },

  create(context) {
    // Files where direct isAuthenticated access is allowed
    const allowedFiles = [
      'storage.ts', // isSourceUsable is defined here
      'credential-manager.ts', // State-setting and inverse check
      'server-builder.ts', // OAuth provider checks (documented)
    ]

    const filename = context.filename || context.getFilename()
    const basename = filename.split('/').pop() || ''

    // Allow in specific files
    if (allowedFiles.includes(basename)) {
      return {}
    }

    return {
      // Match: .config.isAuthenticated access
      MemberExpression(node) {
        // Check if property is 'isAuthenticated'
        if (
          node.property.type === 'Identifier' &&
          node.property.name === 'isAuthenticated'
        ) {
          // Check if accessed via .config.isAuthenticated pattern
          if (
            node.object.type === 'MemberExpression' &&
            node.object.property.type === 'Identifier' &&
            node.object.property.name === 'config'
          ) {
            context.report({
              node,
              messageId: 'useIsSourceUsable',
            })
          }
        }
      },
    }
  },
}
