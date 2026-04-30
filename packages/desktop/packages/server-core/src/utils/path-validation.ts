import { statSync, type Stats } from 'fs'
import { dirname, win32 as pathWin32 } from 'path'

export interface PathValidationResult {
  valid: boolean
  reason?: string
}

type StatLike = (path: string) => Stats

function isAbsolutePathForPlatform(path: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
  }
  return path.startsWith('/')
}

/**
 * Validate path format for the current server platform (no filesystem access).
 * Rejects cross-platform paths (e.g., Windows paths on macOS and vice versa).
 * Platform is injectable for cross-platform unit testing without mocking globals.
 */
export function validatePathFormat(
  path: string,
  platform: NodeJS.Platform = process.platform
): PathValidationResult {
  const trimmed = path.trim()
  const isWindows = platform === 'win32'

  if (!trimmed) {
    return { valid: false, reason: 'Path is required.' }
  }

  if (!isWindows) {
    if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) {
      return { valid: false, reason: 'Windows drive path is not valid on this server. Use a server-side path.' }
    }
    if (trimmed.startsWith('\\\\')) {
      return { valid: false, reason: 'UNC path is not valid on this server. Use a server-side path.' }
    }
    if (!trimmed.startsWith('/')) {
      return { valid: false, reason: 'Path must be absolute (start with /).' }
    }
    return { valid: true }
  }

  if (trimmed.startsWith('/')) {
    return { valid: false, reason: 'Unix path is not valid on this server. Use a Windows path (e.g., C:\\...).' }
  }

  if (!isAbsolutePathForPlatform(trimmed, platform)) {
    return { valid: false, reason: 'Path must be an absolute Windows path (e.g., C:\\... or \\\\server\\share\\...).' }
  }

  return { valid: true }
}

/**
 * Validate that a path is a usable working directory on the current server.
 * Checks format, existence, and that the path is a directory.
 */
export function isValidWorkingDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  if (!formatCheck.valid) return formatCheck

  try {
    const s = statFn(trimmed)
    if (!s.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
  } catch {
    return { valid: false, reason: `Directory not found: ${trimmed}` }
  }

  return { valid: true }
}

/**
 * Validate that a workspace root path is usable on the current server.
 * Existing directories are allowed. Non-existent paths are allowed only when
 * their parent directory exists, which supports "create new workspace" flows.
 */
export function isValidWorkspaceRootPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  statFn: StatLike = statSync
): PathValidationResult {
  const trimmed = path.trim()
  const formatCheck = validatePathFormat(trimmed, platform)
  if (!formatCheck.valid) return formatCheck

  try {
    const existing = statFn(trimmed)
    if (!existing.isDirectory()) {
      return { valid: false, reason: `Not a directory: ${trimmed}` }
    }
    return { valid: true }
  } catch {
    let currentPath = trimmed

    while (true) {
      const parentPath = platform === 'win32' ? pathWin32.dirname(currentPath) : dirname(currentPath)

      if (!parentPath || parentPath === currentPath) {
        return { valid: false, reason: `Parent directory not found: ${currentPath}` }
      }

      try {
        const parent = statFn(parentPath)
        if (!parent.isDirectory()) {
          return { valid: false, reason: `Parent path is not a directory: ${parentPath}` }
        }
        return { valid: true }
      } catch {
        currentPath = parentPath
      }
    }
  }
}
