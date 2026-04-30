/**
 * Opens a URL in the default browser.
 *
 * Prefers Electron's shell.openExternal() which uses native OS APIs and
 * works reliably in packaged apps (no PATH dependency).  Falls back to
 * the 'open' npm package for non-Electron environments.
 *
 * The 'open' package spawns `open` (macOS) / `xdg-open` (Linux) as a
 * child process, which fails with `spawn open ENOENT` in some packaged
 * Electron builds where PATH is stripped.
 *
 * ALWAYS use this instead of importing 'open' directly.
 *
 * @param url - The URL to open in the default browser
 */
export async function openUrl(url: string): Promise<void> {
  // Prefer Electron's native API — no child process spawn, no PATH issues.
  try {
    const { shell } = await import('electron');
    await shell.openExternal(url);
    return;
  } catch {
    // Not in Electron main process — fall back to 'open' package.
  }

  const open = await import('open');
  const openFn = open.default || open;
  await openFn(url);
}
