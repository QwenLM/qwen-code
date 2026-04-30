/**
 * ESLint Rule: no-localstorage
 *
 * Warns against using localStorage in Craft Agent codebase.
 * All persistent user settings should be stored in file-based configs
 * (preferences.json, workspace configs) for consistency with Craft Agent
 * architecture principles.
 *
 * Bad:
 *   localStorage.getItem('key')
 *   localStorage.setItem('key', 'value')
 *   window.localStorage.getItem('key')
 *
 * Good:
 *   // Use IPC to read/write preferences
 *   window.electronAPI.readPreferences()
 *   window.electronAPI.writePreferences(content)
 *
 * Why: File-based configs are:
 *   - Portable (sync via cloud services)
 *   - Editable (users can manually modify)
 *   - Consistent (all settings in one place)
 *   - Inspectable (easy debugging)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow localStorage usage. Use file-based preferences instead.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noLocalStorage:
        "Avoid localStorage in Craft Agent. Store settings in ~/.craft-agent/preferences.json using window.electronAPI.readPreferences/writePreferences. See packages/shared/src/config/preferences.ts for the preferences API.",
    },
    schema: [],
  },

  create(context) {
    /**
     * Check if a node is a localStorage access (localStorage or window.localStorage)
     */
    function isLocalStorageAccess(node) {
      // Direct: localStorage.getItem
      if (node.type === 'Identifier' && node.name === 'localStorage') {
        return true
      }

      // window.localStorage
      if (
        node.type === 'MemberExpression' &&
        node.object.type === 'Identifier' &&
        node.object.name === 'window' &&
        node.property.type === 'Identifier' &&
        node.property.name === 'localStorage'
      ) {
        return true
      }

      return false
    }

    return {
      // Catch localStorage.getItem(), localStorage.setItem(), etc.
      MemberExpression(node) {
        if (isLocalStorageAccess(node.object)) {
          context.report({
            node,
            messageId: 'noLocalStorage',
          })
        }
      },

      // Catch direct localStorage references (e.g., passing it as argument)
      Identifier(node) {
        if (node.name === 'localStorage') {
          // Only report if it's being used (not just referenced in a type)
          const parent = node.parent
          if (
            parent &&
            parent.type === 'MemberExpression' &&
            parent.object === node
          ) {
            // Already handled by MemberExpression rule
            return
          }
          // Report standalone localStorage references
          if (parent && parent.type !== 'TSTypeReference') {
            context.report({
              node,
              messageId: 'noLocalStorage',
            })
          }
        }
      },
    }
  },
}
