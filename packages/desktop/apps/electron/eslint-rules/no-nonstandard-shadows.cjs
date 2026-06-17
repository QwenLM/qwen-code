/**
 * ESLint Rule: no-nonstandard-shadows
 *
 * Enforces approved shadow usage:
 * - Allows only specific shadow-* utility classes
 * - Disallows arbitrary shadow classes (shadow-[...]) unless explicitly allowlisted
 * - Disallows inline style boxShadow values
 * - Disallows direct style assignments (el.style.boxShadow = ...)
 */

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Allow only approved shadow utilities and block inline boxShadow usage.',
      category: 'Best Practices',
      recommended: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedClasses: {
            type: 'array',
            items: { type: 'string' },
          },
          allowInlineNone: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      disallowedClass:
        'Disallowed shadow class "{{className}}". Use approved shadow classes only: {{allowed}}.',
      disallowedInline:
        'Avoid inline boxShadow usage. Use approved shadow utility classes (for example shadow-minimal/shadow-modal-small).',
    },
  },

  create(context) {
    const options = context.options[0] || {}
    const allowedClasses = new Set(
      options.allowedClasses || [
        'shadow-none',
        'shadow-minimal',
        'shadow-tinted',
        'shadow-thin',
        'shadow-middle',
        'shadow-strong',
        'shadow-panel-focused',
        'shadow-modal-small',
        'shadow-bottom-border',
        'shadow-bottom-border-thin',
      ]
    )

    const allowInlineNone = options.allowInlineNone !== false
    const allowedSummary = Array.from(allowedClasses).sort().join(', ')

    function reportDisallowedClass(node, className) {
      context.report({
        node,
        messageId: 'disallowedClass',
        data: {
          className,
          allowed: allowedSummary,
        },
      })
    }

    function checkStringForShadowTokens(node, text) {
      if (!text || !text.includes('shadow-')) return

      const regex = /shadow-[^\s'"`]+/g
      let match

      while ((match = regex.exec(text)) !== null) {
        const token = match[0]
        const start = match.index
        const prev = start > 0 ? text[start - 1] : ''

        // Ignore CSS custom property names like --shadow-color, --shadow-minimal-flat
        if (prev === '-') continue

        if (token.startsWith('shadow-[') && !allowedClasses.has(token)) {
          reportDisallowedClass(node, token)
          continue
        }
        if (!allowedClasses.has(token)) {
          reportDisallowedClass(node, token)
        }
      }
    }

    function isBoxShadowPropertyKey(node) {
      if (!node) return false
      if (node.type === 'Identifier') return node.name === 'boxShadow'
      if (node.type === 'Literal') return node.value === 'boxShadow'
      return false
    }

    function isStyleBoxShadowAssignment(node) {
      return (
        node &&
        node.type === 'MemberExpression' &&
        !node.computed &&
        node.property &&
        node.property.type === 'Identifier' &&
        node.property.name === 'boxShadow' &&
        node.object &&
        node.object.type === 'MemberExpression' &&
        !node.object.computed &&
        node.object.property &&
        node.object.property.type === 'Identifier' &&
        node.object.property.name === 'style'
      )
    }

    function isNoneLiteral(node) {
      return (
        node &&
        node.type === 'Literal' &&
        typeof node.value === 'string' &&
        node.value.trim().toLowerCase() === 'none'
      )
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        checkStringForShadowTokens(node, node.value)
      },

      TemplateLiteral(node) {
        if (node.expressions.length > 0) return
        const text = node.quasis.map((q) => q.value.cooked ?? '').join('')
        checkStringForShadowTokens(node, text)
      },

      Property(node) {
        if (!isBoxShadowPropertyKey(node.key)) return
        if (allowInlineNone && isNoneLiteral(node.value)) return
        context.report({ node: node.value, messageId: 'disallowedInline' })
      },

      AssignmentExpression(node) {
        if (!isStyleBoxShadowAssignment(node.left)) return
        if (allowInlineNone && isNoneLiteral(node.right)) return
        context.report({ node: node.right, messageId: 'disallowedInline' })
      },
    }
  },
}
