/// <reference types="vitest" />
declare global {
  namespace Vi {
    interface Assertion {
      /**
       * Vitest-compatible version of testing-library matchers
       * to resolve conflicts between @testing-library/jest-dom and vitest
       */

      // Basic DOM matchers
      toBeInTheDocument(): Vi.Assertion;
      toBeVisible(): Vi.Assertion;
      toBeEmptyDOMElement(): Vi.Assertion;

      // Content matchers
      toHaveTextContent(text: string | RegExp, options?: { normalizeWhitespace: boolean }): Vi.Assertion;
      toHaveAttribute(name: string, value?: string): Vi.Assertion;

      // Class and style matchers
      toHaveClass(...classNames: string[]): Vi.Assertion;
      toHaveStyle(css: Record<string, unknown>): Vi.Assertion;

      // Form element matchers
      toHaveFocus(): Vi.Assertion;
      toHaveFormValues(expectedValues: Record<string, unknown>): Vi.Assertion;
      toBeDisabled(): Vi.Assertion;
      toBeEnabled(): Vi.Assertion;
      toBeRequired(): Vi.Assertion;
      toBeValid(): Vi.Assertion;
      toBeInvalid(): Vi.Assertion;

      // DOM structure matchers
      toContainElement(element: Element | null): Vi.Assertion;
      toContainHTML(html: string): Vi.Assertion;
      toHaveAccessibleDescription(description?: string | RegExp): Vi.Assertion;
      toHaveAccessibleName(name?: string | RegExp): Vi.Assertion;

      // Value matchers
      toHaveValue(value?: unknown): Vi.Assertion;
      toHaveDisplayValue(value: string | RegExp | (string | RegExp)[]): Vi.Assertion;

      // Event matchers
      toBeChecked(): Vi.Assertion;
      toBePartiallyChecked(): Vi.Assertion;
    }

    interface ExpectStatic {
      // Add any additional expect matchers needed
    }
  }
}

// Export to make this an ES module
export {};