import path from 'node:path';

export function resolveLogRoot(
  platform,
  env,
  { isolatedHome, isolatedState, appId },
) {
  if (platform === 'darwin') {
    return path.join(isolatedHome, 'Library', 'Logs', appId);
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (!localAppData) {
      throw new Error(
        'LOCALAPPDATA is required to locate Windows desktop logs.',
      );
    }
    // Tauri resolves app_log_dir() via SHGetKnownFolderPath on Windows,
    // ignoring the LOCALAPPDATA env override used on other platforms.
    return path.join(localAppData, appId, 'logs');
  }
  return path.join(isolatedState, appId, 'logs');
}

export function sliceNewLog(contents, previousLog) {
  if (!contents.startsWith(previousLog)) {
    return { text: contents, baseline: '' };
  }
  return { text: contents.slice(previousLog.length), baseline: previousLog };
}
