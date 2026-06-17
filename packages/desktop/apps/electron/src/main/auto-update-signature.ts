import { spawnSync } from 'child_process'
import * as path from 'path'

export interface MacCodeSignatureStatus {
  trustedForAutoUpdate: boolean
  appBundlePath: string
  reason?: 'codesign-failed' | 'adhoc-signature' | 'missing-team-identifier'
  signature?: string
  teamIdentifier?: string
  diagnostic?: string
}

function parseCodesignField(output: string, field: string): string | undefined {
  const match = output.match(new RegExp(`^${field}=(.*)$`, 'm'))
  return match?.[1]?.trim()
}

export function getMacAppBundlePath(executablePath: string): string {
  return path.dirname(path.dirname(path.dirname(executablePath)))
}

export function parseMacCodeSignatureStatus(
  appBundlePath: string,
  exitStatus: number | null,
  output: string,
): MacCodeSignatureStatus {
  if (exitStatus !== 0) {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'codesign-failed',
      diagnostic: output.trim(),
    }
  }

  const signature = parseCodesignField(output, 'Signature')
  const teamIdentifier = parseCodesignField(output, 'TeamIdentifier')

  if (signature === 'adhoc') {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'adhoc-signature',
      signature,
      teamIdentifier,
    }
  }

  if (!teamIdentifier || teamIdentifier === 'not set') {
    return {
      trustedForAutoUpdate: false,
      appBundlePath,
      reason: 'missing-team-identifier',
      signature,
      teamIdentifier,
    }
  }

  return {
    trustedForAutoUpdate: true,
    appBundlePath,
    signature,
    teamIdentifier,
  }
}

export function getCurrentMacCodeSignatureStatus(executablePath: string): MacCodeSignatureStatus {
  const appBundlePath = getMacAppBundlePath(executablePath)
  const result = spawnSync('/usr/bin/codesign', ['-d', '-vvv', appBundlePath], {
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`

  return parseMacCodeSignatureStatus(appBundlePath, result.status, output)
}
