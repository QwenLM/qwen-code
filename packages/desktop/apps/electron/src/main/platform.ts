/**
 * Electron platform factory — creates PlatformServices from Electron APIs.
 *
 * Extracted from main/index.ts so it can be injected into bootstrapServer()
 * without duplicating construction logic.
 */

import type { PlatformServices } from '../runtime/platform'

export interface ElectronPlatformOptions {
  app: Electron.App
  nativeImage: typeof import('electron').nativeImage
  shell: typeof import('electron').shell
  nativeTheme: typeof import('electron').nativeTheme
  logger: PlatformServices['logger']
  isDebugMode: boolean
  getLogFilePath?: () => string | undefined
  captureError?: (error: Error) => void
}

export function createElectronPlatform(opts: ElectronPlatformOptions): PlatformServices {
  const { app, nativeImage, shell, nativeTheme, logger } = opts

  return {
    appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    openPath: (p) => shell.openPath(p).then(() => {}),
    showItemInFolder: (p) => shell.showItemInFolder(p),
    quit: () => app.quit(),
    systemDarkMode: () => nativeTheme.shouldUseDarkColors,
    imageProcessor: {
      async getMetadata(buffer) {
        const img = nativeImage.createFromBuffer(buffer)
        if (img.isEmpty()) return null
        const { width, height } = img.getSize()
        return (width && height) ? { width, height } : null
      },
      async process(input, processOpts = {}) {
        const img = typeof input === 'string'
          ? nativeImage.createFromPath(input)
          : nativeImage.createFromBuffer(input)
        if (img.isEmpty()) throw new Error('Invalid image input')

        let result = img
        if (processOpts.resize) {
          const { width: tw, height: th } = processOpts.resize
          const fit = processOpts.fit ?? 'inside'
          if (fit === 'inside') {
            const { width: sw, height: sh } = result.getSize()
            const scale = Math.min(tw / sw, th / sh, 1)
            result = result.resize({
              width: Math.round(sw * scale),
              height: Math.round(sh * scale),
            })
          } else {
            result = result.resize({ width: tw, height: th })
          }
        }
        return (processOpts.format === 'jpeg')
          ? result.toJPEG(processOpts.quality ?? 90)
          : result.toPNG()
      },
    },
    logger,
    isDebugMode: opts.isDebugMode,
    getLogFilePath: opts.getLogFilePath,
    captureError: opts.captureError,
  }
}
