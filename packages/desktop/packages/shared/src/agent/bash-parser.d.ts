/**
 * Type declarations for bash-parser
 *
 * bash-parser is a JavaScript library for parsing bash scripts into an AST.
 * We define our own types in bash-validator.ts since the library doesn't ship types.
 *
 * @see https://github.com/vorpaljs/bash-parser
 */

declare module 'bash-parser' {
  /**
   * Parse a bash command string into an AST.
   *
   * The AST nodes are typed in bash-validator.ts as:
   * - Script: Top-level node containing commands array
   * - Command: Simple command with name and suffix (args)
   * - LogicalExpression: && (and) or || (or) chains
   * - Pipeline: Piped commands (|)
   * - Subshell: Commands in parentheses (...)
   * - CompoundList: List of commands in subshell or similar
   * - Redirect: File redirections (>, >>, <)
   * - Word: Text token with optional expansions
   *
   * @param command - The bash command string to parse
   * @returns AST root node (Script type)
   */
  function bashParser(command: string): unknown;
  export default bashParser;
}
