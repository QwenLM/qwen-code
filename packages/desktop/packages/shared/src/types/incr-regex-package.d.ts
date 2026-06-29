/**
 * Type declarations for incr-regex-package
 *
 * This library provides incremental regex matching, allowing character-by-character
 * processing to determine WHERE a match fails. Useful for generating smart error messages.
 *
 * @see https://github.com/nurulc/incr-regex-package
 */
declare module 'incr-regex-package' {
  /** Match state: complete valid match achieved */
  export const DONE: symbol;

  /** Match state: valid so far, but additional characters expected */
  export const MORE: symbol;

  /** Match state: valid stopping point, but more characters could extend the match */
  export const MAYBE: symbol;

  /** Match state: invalid input received */
  export const FAILED: symbol;

  /**
   * Incremental regex matcher class (IREGEX).
   * Allows processing input character-by-character to find exact failure points.
   *
   * @example
   * const rx = new IREGEX("^git\\s+(status|log|diff)");
   * const [success, count, matched] = rx.matchStr("git -C /path status");
   * // Returns [false, 4, "git "] - matched 4 chars before failing at "-C"
   */
  export class IREGEX {
    /**
     * Create a new incremental regex matcher.
     * @param pattern - Regular expression pattern as a string
     */
    constructor(pattern: string);

    /**
     * Process a single character.
     * @param char - Single character to match
     * @returns true if character was accepted, false if rejected
     */
    match(char: string): boolean;

    /**
     * Process an entire string at once.
     * @param str - String to match
     * @returns Tuple of [success, charCount, matchedString]
     *   - success: whether the entire string matched
     *   - charCount: number of characters successfully matched before failure
     *   - matchedString: the substring that was matched
     */
    matchStr(str: string): [boolean, number, string];

    /**
     * Get current matching state.
     * @returns One of DONE, MORE, MAYBE, or FAILED
     */
    state(): symbol;

    /**
     * Get minimum required input as a mask string.
     * Uses underscores for variable positions.
     * @returns Mask string showing required format (e.g., "___-___-____" for phone)
     */
    minChars(): string;

    /**
     * Reset the matcher to its initial state.
     */
    reset(): void;

    /**
     * Create an independent copy of this matcher.
     * @returns New IREGEX instance with same pattern
     */
    clone(): IREGEX;

    /**
     * Create an independent copy of this matcher (alias for clone).
     * @returns New IREGEX instance with same pattern
     */
    copy(): IREGEX;
  }
}
