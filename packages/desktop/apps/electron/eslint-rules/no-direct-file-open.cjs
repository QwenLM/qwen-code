/**
 * ESLint Rule: no-direct-file-open
 *
 * Prevents calling window.electronAPI.openFile() directly in renderer code.
 * All file-open calls should go through the link interceptor (via AppShellContext
 * or PlatformContext's onOpenFile) so the app can show in-app previews for
 * supported file types instead of always opening in the default external app.
 *
 * Allowed in:
 *   - App.tsx (link interceptor implementation)
 *   - useLinkInterceptor.ts (link interceptor fallback)
 *
 * Bad:
 *   window.electronAPI.openFile(path)
 *
 * Good:
 *   const { onOpenFile } = useAppShellContext()
 *   onOpenFile(path)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct window.electronAPI.openFile() calls. Use onOpenFile from context instead.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noDirectFileOpen:
        'Use onOpenFile from AppShellContext or PlatformContext instead of calling window.electronAPI.openFile() directly. This ensures the link interceptor can show in-app previews for supported file types.',
    },
    schema: [],
  },

  create(context) {
    // Allow direct calls in the interceptor implementation files
    const filename = context.filename || context.getFilename()
    const basename = filename.split('/').pop() || ''
    if (basename === 'App.tsx' || basename === 'useLinkInterceptor.ts') {
      return {}
    }

    return {
      // Match: window.electronAPI.openFile(...)
      CallExpression(node) {
        const callee = node.callee
        if (
          callee.type === 'MemberExpression' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'openFile' &&
          callee.object.type === 'MemberExpression' &&
          callee.object.property.type === 'Identifier' &&
          callee.object.property.name === 'electronAPI'
        ) {
          context.report({
            node,
            messageId: 'noDirectFileOpen',
          })
        }
      },
    }
  },
}
