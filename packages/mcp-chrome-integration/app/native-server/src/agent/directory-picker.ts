/**
 * Directory Picker Service.
 *
 * Provides cross-platform directory selection using native system dialogs.
 * Uses platform-specific commands:
 * - macOS: osascript (AppleScript)
 * - Windows: PowerShell
 * - Linux: zenity or kdialog
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execAsync = promisify(exec);

export interface DirectoryPickerResult {
  success: boolean;
  path?: string;
  cancelled?: boolean;
  error?: string;
}

/**
 * Open a native directory picker dialog.
 * Returns the selected directory path or indicates cancellation.
 */
export async function openDirectoryPicker(
  title = 'Select Project Directory',
): Promise<DirectoryPickerResult> {
  const platform = os.platform();

  try {
    switch (platform) {
      case 'darwin':
        return await openMacOSPicker(title);
      case 'win32':
        return await openWindowsPicker(title);
      case 'linux':
        return await openLinuxPicker(title);
      default:
        return {
          success: false,
          error: `Unsupported platform: ${platform}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * macOS: Use osascript to open Finder folder picker.
 */
async function openMacOSPicker(title: string): Promise<DirectoryPickerResult> {
  const script = `
    set selectedFolder to choose folder with prompt "${title}"
    return POSIX path of selectedFolder
  `;

  try {
    const { stdout } = await execAsync(`osascript -e '${script}'`);
    const path = stdout.trim();
    if (path) {
      return { success: true, path };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    // User cancelled returns error code 1
    const err = error as { code?: number; stderr?: string };
    if (err.code === 1) {
      return { success: false, cancelled: true };
    }
    throw error;
  }
}

/**
 * Windows: Use PowerShell to open folder browser dialog.
 */
async function openWindowsPicker(title: string): Promise<DirectoryPickerResult> {
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "${title}"
    $dialog.ShowNewFolderButton = $true
    $result = $dialog.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      Write-Output $dialog.SelectedPath
    }
  `;

  // Escape for command line
  const escapedScript = psScript.replace(/"/g, '\\"').replace(/\n/g, ' ');

  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "${escapedScript}"`,
      { timeout: 60000 }, // 60 second timeout
    );
    const path = stdout.trim();
    if (path) {
      return { success: true, path };
    }
    return { success: false, cancelled: true };
  } catch (error) {
    const err = error as { killed?: boolean };
    if (err.killed) {
      return { success: false, error: 'Dialog timed out' };
    }
    throw error;
  }
}

/**
 * Linux: Try zenity first, then kdialog as fallback.
 */
async function openLinuxPicker(title: string): Promise<DirectoryPickerResult> {
  // Try zenity first (GTK)
  try {
    const { stdout } = await execAsync(`zenity --file-selection --directory --title="${title}"`, {
      timeout: 60000,
    });
    const path = stdout.trim();
    if (path) {
      return { success: true, path };
    }
    return { success: false, cancelled: true };
  } catch (zenityError) {
    // zenity returns exit code 1 on cancel, 5 if not installed
    const err = zenityError as { code?: number };
    if (err.code === 1) {
      return { success: false, cancelled: true };
    }

    // Try kdialog as fallback (KDE)
    try {
      const { stdout } = await execAsync(`kdialog --getexistingdirectory ~ --title "${title}"`, {
        timeout: 60000,
      });
      const path = stdout.trim();
      if (path) {
        return { success: true, path };
      }
      return { success: false, cancelled: true };
    } catch (kdialogError) {
      const kdErr = kdialogError as { code?: number };
      if (kdErr.code === 1) {
        return { success: false, cancelled: true };
      }

      return {
        success: false,
        error: 'No directory picker available. Please install zenity or kdialog.',
      };
    }
  }
}
