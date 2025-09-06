import { COLOR_OPTIONS } from './constants.js';

export const shouldShowColor = (backgroundColor?: string): boolean =>
  backgroundColor !== undefined && backgroundColor !== 'auto';

export const getColorForDisplay = (colorName?: string): string | undefined =>
  !colorName || colorName === 'auto'
    ? undefined
    : COLOR_OPTIONS.find((color) => color.name === colorName)?.value;

/**
 * Sanitizes user input by removing dangerous characters and normalizing whitespace.
 */
export function sanitizeInput(input: string): string {
  return (
    input
      .trim()
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
      .replace(/\s+/g, ' ') // Normalize whitespace
  ); // Limit length
}
