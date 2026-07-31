import { PERMISSION_MODE_ORDER, type PermissionMode } from '@craft-agent/shared/agent/mode-types'

export function getPermissionModeCycle(enabledModes?: readonly PermissionMode[]): PermissionMode[] {
  return enabledModes && enabledModes.length >= 2
    ? [...enabledModes]
    : [...PERMISSION_MODE_ORDER]
}

export function getNextPermissionMode(
  currentMode: PermissionMode,
  enabledModes?: readonly PermissionMode[]
): PermissionMode {
  const modes = getPermissionModeCycle(enabledModes)
  const currentIndex = modes.indexOf(currentMode)
  if (currentIndex === -1) return modes[0] ?? 'allow-all'
  return modes[(currentIndex + 1) % modes.length] ?? 'allow-all'
}
