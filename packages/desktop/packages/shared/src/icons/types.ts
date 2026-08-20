/**
 * Unified Icon Types
 *
 * Shared type definitions for the centralised icon system.
 * Used by EntityIcon base component and all entity-specific wrappers
 * (SourceAvatar, SkillAvatar, StatusIcon).
 *
 * This module is browser-safe (no Node.js dependencies).
 */

// ============================================================================
// Core Types
// ============================================================================

/**
 * Icon configuration as stored in entity config files.
 * The `icon` field can be an emoji string, an HTTP(S) URL, or undefined
 * (in which case local icon files are auto-discovered).
 */
export interface IconConfig {
  /** Emoji string, HTTP(S) URL, or undefined (auto-discover file) */
  icon?: string
}

/**
 * Resolved icon ready for rendering by EntityIcon.
 * Produced by the useEntityIcon hook after cache lookup / IPC loading.
 */
export interface ResolvedEntityIcon {
  /** The kind of icon that was resolved */
  kind: 'emoji' | 'file' | 'fallback'
  /**
   * For emoji: the emoji string (e.g. "🔧").
   * For file: data URL (base64-encoded image or themed SVG data URL).
   * For fallback: undefined.
   */
  value?: string
  /**
   * Whether the icon responds to currentColor styling.
   * - true: SVGs that use currentColor - status/label color can be applied via CSS
   * - false: Emojis, raster images, SVGs with hardcoded colors
   */
  colorable: boolean
  /**
   * Raw SVG content (sanitized) for inline rendering.
   * Only present when colorable=true, enabling CSS color inheritance.
   * EntityIcon renders this inline (dangerouslySetInnerHTML) so parent
   * color classes (e.g. 'text-success') cascade into SVG fills/strokes.
   */
  rawSvg?: string
}

// ============================================================================
// Size System
// ============================================================================

/** Standard size variants shared across all entity icons */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/** Size → Tailwind container class (width & height) */
export const ICON_SIZE_CLASSES: Record<IconSize, string> = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
  xl: 'h-7 w-7',
}

/** Size → Tailwind emoji font size (visually balanced within container) */
export const ICON_EMOJI_SIZES: Record<IconSize, string> = {
  xs: 'text-[10px]',
  sm: 'text-[11px]',
  md: 'text-[13px]',
  lg: 'text-[16px]',
  xl: 'text-[18px]',
}
