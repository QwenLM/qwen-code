/**
 * Colors module - re-exports all color types, resolution, and validation.
 *
 * Import via: `import { EntityColor, resolveEntityColor } from '@craft-agent/shared/colors'`
 */
export {
  type SystemColorName,
  type SystemColor,
  type CustomColor,
  type EntityColor,
  SYSTEM_COLOR_NAMES,
} from './types.ts'

export {
  resolveEntityColor,
  parseSystemColor,
  isSystemColorName,
  isSystemColor,
  deriveDarkVariant,
  type ParsedSystemColor,
} from './resolve.ts'

export {
  isValidCSSColor,
  isValidSystemColor,
  isValidEntityColor,
  EntityColorSchema,
} from './validate.ts'

export {
  DEFAULT_STATUS_COLORS,
  DEFAULT_STATUS_FALLBACK,
  getDefaultStatusColor,
} from './defaults.ts'

export {
  migrateColorValue,
  migrateStatusColors,
  migrateLabelColors,
} from './migrate.ts'
