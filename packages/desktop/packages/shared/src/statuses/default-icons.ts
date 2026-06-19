/**
 * Default Status Icon SVGs
 *
 * Embedded SVG strings for default status icons.
 * These are auto-created as files in statuses/icons/ when missing.
 */

/**
 * Default icon SVGs mapped by filename (without .svg extension)
 */
export const DEFAULT_ICON_SVGS: Record<string, string> = {
  /**
   * Backlog - CircleDashed (larger gaps)
   * Empty circle with widely-spaced dashed stroke for "not yet planned"
   */
  'backlog': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" stroke-dasharray="6 5" />
</svg>`,

  /**
   * Todo - Circle (solid outline)
   * Empty circle with solid stroke for "ready to work on"
   */
  'todo': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
</svg>`,

  /**
   * In Progress - CircleProgress
   * Half-filled circle (left side filled)
   */
  'in-progress': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
  <path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" stroke="none" />
</svg>`,

  /**
   * Needs Review - CircleEye
   * Circle with dot in center
   */
  'needs-review': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" />
  <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
</svg>`,

  /**
   * Done - CircleCheckFilled
   * Filled circle with checkmark
   */
  'done': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
  <circle cx="12" cy="12" r="10" />
  <path d="M8 12l3 3 5-5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>`,

  /**
   * Cancelled - CircleXFilled
   * Filled circle with X mark
   */
  'cancelled': `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none">
  <circle cx="12" cy="12" r="10" />
  <path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
</svg>`,
};

/**
 * Get default icon SVG by status ID
 */
export function getDefaultIconSvg(statusId: string): string | undefined {
  return DEFAULT_ICON_SVGS[statusId];
}
