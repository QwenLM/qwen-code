/**
 * Core utilities
 */

export { debug } from './debug.ts';
export { normalizePath, pathStartsWith, stripPathPrefix } from './paths.ts';
export {
  utf16IndexToByteOffset,
  byteOffsetToUtf16Index,
  contentBadgeToTextElement,
  contentBadgesToTextElements,
  textElementToContentBadge,
  textElementsToContentBadges,
} from './text-elements.ts';
