/**
 * Type declarations for testing-library matchers
 * This file adds type definitions for matchers like toBeInTheDocument
 */

import '@testing-library/jest-dom';

declare global {
  namespace jest {
    interface Matchers<R> {
      toBeInTheDocument(): R;
      toBeVisible(): R;
      toBeEmptyDOMElement(): R;
      toHaveTextContent(text: string | RegExp, options?: { normalizeWhitespace: boolean }): R;
      toHaveAttribute(attr: string, value?: string): R;
      toHaveClass(...classNames: string[]): R;
      toHaveStyle(css: Record<string, unknown>): R;
      toHaveFocus(): R;
      toHaveFormValues(expectedValues: Record<string, unknown>): R;
      toBeDisabled(): R;
      toBeEnabled(): R;
      toBeInvalid(): R;
      toBeRequired(): R;
      toBeValid(): R;
      toContainElement(element: Element | null): R;
      toContainHTML(htmlText: string): R;
    }
  }
}

export {};