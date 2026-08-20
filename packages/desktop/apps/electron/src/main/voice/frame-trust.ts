/**
 * Trust gate for the voice stream URL, which embeds the loopback RPC server
 * token. Extracted from main/index.ts (pure — no Electron deps) so the sole
 * guard deciding whether a frame receives the token is unit-testable without
 * booting Electron.
 */

/**
 * Derive the renderer dev-server origin from a `VITE_DEV_SERVER_URL` value.
 * Returns undefined when unset or unparseable (production builds have no dev
 * server, so there is no dev origin to trust).
 */
export function getRendererDevOrigin(
  devServerUrl: string | undefined,
): string | undefined {
  if (!devServerUrl) return undefined;
  try {
    return new URL(devServerUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * The app's own renderer is loaded from `file://` (packaged, via loadFile) or
 * the Vite dev server (development). Anything else — an injected/cross-origin
 * frame or a stray webview — is untrusted. Mirrors the will-navigate origin
 * trust check in window-manager.
 *
 * @param url The frame URL to vet (undefined when the frame has none).
 * @param devServerUrl The `VITE_DEV_SERVER_URL` env value (undefined in prod).
 */
export function isTrustedRendererFrameUrl(
  url: string | undefined,
  devServerUrl: string | undefined,
): boolean {
  if (!url) return false;
  if (url.startsWith('file://')) return true;
  const devOrigin = getRendererDevOrigin(devServerUrl);
  if (!devOrigin) return false;
  try {
    return new URL(url).origin === devOrigin;
  } catch {
    return false;
  }
}
