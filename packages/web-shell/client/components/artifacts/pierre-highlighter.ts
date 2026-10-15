import {
  createBundledHighlighter,
  createSingletonShorthands,
} from 'shiki-files/core';
import { createJavaScriptRegexEngine } from 'shiki-files/engine/javascript';
import { bundledLanguages, bundledThemes } from './pierre-resources';

/** @internal */
export {
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
} from 'shiki-files/core';
/** @internal */
export { createOnigurumaEngine } from 'shiki-files/engine/oniguruma';
/** @internal */
export { createJavaScriptRegexEngine, bundledLanguages };

/** @internal */
export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: createJavaScriptRegexEngine,
});
/** @internal */
export const { codeToHtml } = createSingletonShorthands(createHighlighter);
