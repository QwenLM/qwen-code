/**
 * Settings Components
 *
 * Reusable UI components for building settings pages.
 * Provides consistent styling and behavior across the app.
 *
 * @example
 * import {
 *   SettingsSection,
 *   SettingsCard,
 *   SettingsToggle,
 *   SettingsRadioGroup,
 *   SettingsRadioCard,
 * } from '@/components/settings'
 */

// Structure
export {
  SettingsSection,
  SettingsGroup,
  SettingsDivider,
  type SettingsSectionProps,
  type SettingsGroupProps,
  type SettingsDividerProps,
} from './SettingsSection'

export {
  SettingsCard,
  SettingsCardContent,
  SettingsCardFooter,
  type SettingsCardProps,
} from './SettingsCard'

// Rows
export {
  SettingsRow,
  SettingsRowLabel,
  type SettingsRowProps,
} from './SettingsRow'

export {
  SettingsToggle,
  type SettingsToggleProps,
} from './SettingsToggle'

// Selection
export {
  SettingsRadioGroup,
  SettingsRadioCard,
  SettingsRadioOption,
  type SettingsRadioGroupProps,
  type SettingsRadioCardProps,
  type SettingsRadioOptionProps,
} from './SettingsRadioGroup'

export {
  SettingsSegmentedControl,
  SettingsSegmentedControlCard,
  type SettingsSegmentedControlProps,
  type SettingsSegmentedOption,
  type SettingsSegmentedControlCardProps,
  type SettingsSegmentedCardOption,
} from './SettingsSegmentedControl'

export {
  SettingsSelect,
  SettingsSelectRow,
  type SettingsSelectProps,
  type SettingsSelectOption,
  type SettingsSelectRowProps,
} from './SettingsSelect'

export {
  SettingsMenuSelect,
  SettingsMenuSelectRow,
  type SettingsMenuSelectProps,
  type SettingsMenuSelectOption,
  type SettingsMenuSelectRowProps,
} from './SettingsMenuSelect'

// Inputs
export {
  SettingsInput,
  SettingsInputRow,
  SettingsSecretInput,
  type SettingsInputProps,
  type SettingsInputRowProps,
  type SettingsSecretInputProps,
} from './SettingsInput'

export {
  SettingsTextarea,
  type SettingsTextareaProps,
} from './SettingsTextarea'
