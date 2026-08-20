/**
 * Module-level PlatformServices for model fetchers.
 * Avoids circular imports (index.ts → registry.ts → fetchers → index.ts).
 * Must be initialized via setFetcherPlatform() before any model fetching.
 */
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '../runtime/platform'

let _platform: PlatformServices | null = null

// Scoped logger — upgraded from console fallback when setFetcherPlatform() is called.
// ES module live binding: importers of `handlerLog` see the updated value automatically.
export let handlerLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'handler')

export function setFetcherPlatform(platform: PlatformServices): void {
  _platform = platform
  handlerLog = createScopedLogger(platform.logger, 'handler')
}

export function getHostRuntime() {
  if (!_platform) throw new Error('setFetcherPlatform() must be called before model fetching')
  return {
    appRootPath: _platform.appRootPath,
    resourcesPath: _platform.resourcesPath,
    isPackaged: _platform.isPackaged,
  }
}
