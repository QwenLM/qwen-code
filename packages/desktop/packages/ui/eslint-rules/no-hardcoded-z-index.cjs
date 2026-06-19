/**
 * ESLint Rule: no-hardcoded-z-index
 *
 * Enforces centralized z-index tokens by disallowing hardcoded literal values
 * in style objects and direct style assignments.
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow hardcoded zIndex literals. Use centralized z-index tokens/constants.',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [],
    messages: {
      noHardcodedZIndex:
        'Avoid hardcoded zIndex values. Use z-index tokens (for example var(--z-floating-menu, 400)), Tailwind z-* utilities, or a named constant.',
    },
  },

  create(context) {
    function isZIndexPropertyName(node) {
      if (!node) return false
      if (node.type === 'Identifier') return node.name === 'zIndex'
      if (node.type === 'Literal') return node.value === 'zIndex'
      return false
    }

    function getStaticTemplateValue(node) {
      if (node.type !== 'TemplateLiteral') return null
      if (node.expressions.length > 0) return null
      return node.quasis.map((q) => q.value.cooked ?? '').join('')
    }

    function isAllowedZIndexString(value) {
      const normalized = value.trim().toLowerCase()
      if (normalized.includes('var(--z-')) return true
      if (
        normalized === 'auto' ||
        normalized === 'inherit' ||
        normalized === 'initial' ||
        normalized === 'unset' ||
        normalized === 'revert' ||
        normalized === 'revert-layer'
      ) {
        return true
      }
      return false
    }

    function isHardcodedLiteralValue(node) {
      if (!node) return false

      if (node.type === 'Literal') {
        if (typeof node.value === 'number') return true
        if (typeof node.value === 'string') return !isAllowedZIndexString(node.value)
        return false
      }

      if (node.type === 'TemplateLiteral') {
        const staticValue = getStaticTemplateValue(node)
        if (staticValue == null) return false
        return !isAllowedZIndexString(staticValue)
      }

      return false
    }

    function isStyleZIndexMemberExpression(node) {
      return (
        node &&
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property &&
        node.property.type === 'Identifier' &&
        node.property.name === 'zIndex' &&
        node.object &&
        node.object.type === 'MemberExpression' &&
        !node.object.computed &&
        node.object.property &&
        node.object.property.type === 'Identifier' &&
        node.object.property.name === 'style'
      )
    }

    function isZIndexIdentifier(node) {
      return node && node.type === 'Identifier' && node.name === 'zIndex'
    }

    return {
      Property(node) {
        if (!isZIndexPropertyName(node.key)) return
        if (isHardcodedLiteralValue(node.value)) {
          context.report({ node: node.value, messageId: 'noHardcodedZIndex' })
        }
      },

      AssignmentPattern(node) {
        if (!isZIndexIdentifier(node.left)) return
        if (isHardcodedLiteralValue(node.right)) {
          context.report({ node: node.right, messageId: 'noHardcodedZIndex' })
        }
      },

      AssignmentExpression(node) {
        if (!isStyleZIndexMemberExpression(node.left)) return
        if (isHardcodedLiteralValue(node.right)) {
          context.report({ node: node.right, messageId: 'noHardcodedZIndex' })
        }
      },
    }
  },
}
