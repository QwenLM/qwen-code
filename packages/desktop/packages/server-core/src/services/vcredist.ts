import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface VCRedistCheckResult {
  installed: boolean
  /** Human-readable message suitable for logging or dialogs */
  message: string
  /** Download URL for the correct VC++ Redistributable installer (set when installed=false) */
  downloadUrl?: string
}

/** Get the correct download URL based on CPU architecture */
function getVCRedistDownloadUrl(): string {
  return process.arch === 'arm64'
    ? 'https://aka.ms/vs/17/release/vc_redist.arm64.exe'
    : 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
}

/**
 * Check whether the Microsoft Visual C++ Redistributable is installed on Windows.
 *
 * This is required for onnxruntime (used by markitdown's magika file classifier)
 * to load its native DLLs. Without it, markitdown crashes with a DLL-not-found error
 * when converting PDF, PPTX, DOCX, and XLSX files.
 *
 * On non-Windows platforms, always returns { installed: true } since vcruntime
 * is not relevant (shared libs are managed by the system package manager).
 */
export function checkVCRedistInstalled(): VCRedistCheckResult {
  if (process.platform !== 'win32') {
    return { installed: true, message: 'Not applicable on this platform' }
  }

  // Well-known paths where vcruntime140.dll is installed by VC++ Redistributable.
  // Covers both x64 and ARM64 host scenarios (ARM64 Windows runs x86_64 via emulation,
  // so the x64 DLL in SysWOW64 or System32 is what matters for onnxruntime).
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const dllPaths = [
    join(sysRoot, 'System32', 'vcruntime140.dll'),
    join(sysRoot, 'SysWOW64', 'vcruntime140.dll'),
  ]

  for (const dllPath of dllPaths) {
    if (existsSync(dllPath)) {
      return { installed: true, message: `Found vcruntime140.dll at ${dllPath}` }
    }
  }

  const downloadUrl = getVCRedistDownloadUrl()
  return {
    installed: false,
    downloadUrl,
    message:
      'Microsoft Visual C++ Redistributable is not installed. ' +
      'Document conversion tools (PDF, PPTX, DOCX, XLSX) will not work correctly. ' +
      `Please install it from: ${downloadUrl}`,
  }
}
