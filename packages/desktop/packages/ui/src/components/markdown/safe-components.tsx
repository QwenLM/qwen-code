/**
 * Safe component handling for react-markdown
 *
 * When users type HTML-like content (e.g., `<sq+qr>`), rehype-raw interprets
 * it as an HTML tag. React crashes if the tag name contains invalid characters.
 * This module provides utilities to handle such cases gracefully.
 */

import React from 'react'
import type { Components } from 'react-markdown'

/**
 * UnknownTag - Fallback component for invalid HTML-like tags
 *
 * Renders tags with invalid names (containing +, @, etc.) as plain text
 * instead of crashing React. Always renders both opening and closing tags
 * for consistency (it's escaped text anyway).
 */
export const UnknownTag: React.FC<{ tagName: string; children?: React.ReactNode }> = ({
  tagName,
  children,
}) => (
  <span className="text-muted-foreground">
    {`<${tagName}>`}
    {children}
    {`</${tagName}>`}
  </span>
)

/** Matches valid lowercase HTML tags: div, span, h1, etc. */
const VALID_HTML_TAG = /^[a-z][a-z0-9]*$/

/** Matches valid PascalCase React components: MyComponent, Button, etc. */
const VALID_COMPONENT_NAME = /^[A-Z][a-zA-Z0-9_]*$/

/**
 * Checks if a tag name is valid for React/HTML rendering.
 * Invalid tags contain characters like +, @, -, spaces, etc.
 */
export function isValidTagName(tagName: string): boolean {
  return VALID_HTML_TAG.test(tagName) || VALID_COMPONENT_NAME.test(tagName)
}

/**
 * Determines if a tag should use our fallback component.
 * Returns true for invalid tags not explicitly defined in components.
 */
function shouldUseFallback(prop: string | symbol, target: object): boolean {
  if (typeof prop === 'symbol') return false
  if (prop in target) return false
  return !isValidTagName(prop)
}

/** Descriptor returned for invalid tags to make hasOwnProperty return true */
const INVALID_TAG_DESCRIPTOR: PropertyDescriptor = {
  configurable: true,
  enumerable: true,
  value: undefined, // Actual value comes from `get` trap
  writable: true,
}

/**
 * Wraps a components object with a Proxy to handle unknown/invalid tag names.
 *
 * Returns:
 * - The original component if defined in the components map
 * - undefined for valid HTML/React tag names (lets React handle them)
 * - UnknownTag fallback for invalid tag names (containing +, @, etc.)
 *
 * @example
 * const safeComponents = wrapWithSafeProxy(components)
 * // <div> → handled by React (valid HTML)
 * // <MyComponent> → handled by React (valid component name)
 * // <sq+qr> → rendered as text by UnknownTag
 */
export function wrapWithSafeProxy(components: Partial<Components>): Partial<Components> {
  const fallbackCache = new Map<string, React.FC<{ children?: React.ReactNode }>>()

  return new Proxy(components, {
    get(target, prop) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop)
      if (prop in target) return target[prop as keyof typeof target]
      if (!shouldUseFallback(prop, target)) return undefined

      if (!fallbackCache.has(prop)) {
        const Fallback: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
          <UnknownTag tagName={prop}>{children}</UnknownTag>
        )
        Fallback.displayName = `UnknownTag(${prop})`
        fallbackCache.set(prop, Fallback)
      }
      return fallbackCache.get(prop)
    },

    has(target, prop) {
      if (typeof prop === 'symbol') return Reflect.has(target, prop)
      return prop in target || shouldUseFallback(prop, target)
    },

    // CRITICAL: hast-util-to-jsx-runtime uses Object.hasOwnProperty to check
    // for components, which calls getOwnPropertyDescriptor, not the `has` trap.
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'symbol') return Reflect.getOwnPropertyDescriptor(target, prop)

      const descriptor = Reflect.getOwnPropertyDescriptor(target, prop)
      if (descriptor) return descriptor

      return shouldUseFallback(prop, target) ? INVALID_TAG_DESCRIPTOR : undefined
    },
  })
}
