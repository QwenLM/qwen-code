import {
  createBundledHighlighter,
  createSingletonShorthands,
} from 'shiki-files/core';
import { createJavaScriptRegexEngine } from 'shiki-files/engine/javascript';
import { bundledLanguages, bundledThemes } from './pierre-resources';

export {
  createCssVariablesTheme,
  getTokenStyleObject,
  stringifyTokenStyle,
} from 'shiki-files/core';
export { createOnigurumaEngine } from 'shiki-files/engine/oniguruma';
export { createJavaScriptRegexEngine, bundledLanguages };

export const createHighlighter = createBundledHighlighter({
  langs: bundledLanguages,
  themes: bundledThemes,
  engine: createJavaScriptRegexEngine,
});
export const { codeToHtml } = createSingletonShorthands(createHighlighter);
