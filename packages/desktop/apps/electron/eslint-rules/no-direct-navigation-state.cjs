/**
 * ESLint Rule: no-direct-navigation-state
 *
 * Prevents direct calls to navigation state setters outside of the
 * SIDEBAR_NAVIGATE_EVENT listener in AppShell.tsx. All navigation should
 * go through navigate(routes.xxx()) to ensure:
 *
 * 1. URL/deep link consistency
 * 2. History tracking for back/forward
 * 3. Auto-selection of first item in new views
 *
 * Bad (in click handlers):
 *   setSidebarMode({ type: 'sources' })
 *
 * Good:
 *   navigate(routes.view.sources())
 *   navigate(routes.view.agent(agentId))
 *
 * Note: This rule only checks AppShell.tsx where the navigation state is defined.
 * The setSidebarMode function is not exported, so other files can't use it anyway.
 */

/**
 * Get ancestor nodes for a given node in ESLint 9+
 * ESLint 9 removed context.getAncestors(), so we use sourceCode.getAncestors()
 */
function getAncestors(context, node) {
  const sourceCode = context.sourceCode || context.getSourceCode()
  if (sourceCode.getAncestors) {
    return sourceCode.getAncestors(node)
  }
  // Fallback for older versions
  if (context.getAncestors) {
    return context.getAncestors()
  }
  return []
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow direct calls to setSidebarMode outside the navigation event handler.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noDirectCall:
        "Do not call 'setSidebarMode()' directly. Use navigate(routes.xxx()) instead to ensure URL consistency, history tracking, and auto-selection. Only the handleSidebarNavigate event listener should call setSidebarMode. See the comment at line ~595 in AppShell.tsx.",
    },
    schema: [],
  },

  create(context) {
    // Get the filename - only check AppShell.tsx
    const filename = context.filename || context.getFilename()
    const isAppShell = filename.includes('AppShell.tsx')

    // Only apply this rule to AppShell.tsx
    if (!isAppShell) {
      return {}
    }

    return {
      CallExpression(node) {
        // Only check setSidebarMode calls
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'setSidebarMode'
        ) {
          const ancestors = getAncestors(context, node)

          // Allow if inside handleSidebarNavigate
          for (const ancestor of ancestors) {
            // Check for: const handleSidebarNavigate = useCallback(...)
            if (
              ancestor.type === 'VariableDeclarator' &&
              ancestor.id.type === 'Identifier' &&
              ancestor.id.name === 'handleSidebarNavigate'
            ) {
              return // Allowed - inside the event handler
            }
            // Check for: function handleSidebarNavigate(...)
            if (
              ancestor.type === 'FunctionDeclaration' &&
              ancestor.id &&
              ancestor.id.name === 'handleSidebarNavigate'
            ) {
              return // Allowed
            }
          }

          // Not inside allowed context - report error
          context.report({
            node,
            messageId: 'noDirectCall',
          })
        }
      },
    }
  },
}
