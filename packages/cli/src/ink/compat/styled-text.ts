/**
 * Styled-text utilities — standalone TypeScript port of @jrichman/ink@6.6.7.
 * Origin licence: MIT (Copyright (c) Vadym Demedes <vadimdemedes@hey.com>).
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 *
 * Replaces the previous re-export shim that pointed at the npm ink build files
 * under node_modules. All implementations now live in ./styled-text/*.ts so
 * that packages/cli/src/ink/ has zero runtime dependency on the npm ink package.
 *
 * The set of exported symbols and their types are identical to the old shim, so
 * packages/cli/src/ink/index.ts requires no changes.
 */

// StyledLine class — span-based representation of styled terminal text
export { StyledLine } from './styled-text/styled-line.js';

// Measurement / conversion utilities
export {
  toStyledCharacters,
  styledCharsWidth,
  wordBreakStyledChars,
  widestLineFromStyledChars,
} from './styled-text/measure.js';

// Text wrapping
export { wrapStyledChars } from './styled-text/wrap.js';

// Serialization
export { styledLineToString } from './styled-text/sgr-tokenize.js';
