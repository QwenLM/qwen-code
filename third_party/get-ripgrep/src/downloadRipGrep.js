/* eslint-disable */
/**
 * @license
 * Copyright 2023 Lvce Editor
 * SPDX-License-Identifier: MIT
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import * as os from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const REPOSITORY = `microsoft/ripgrep-prebuilt`
export const RIPGREP_VERSION =
  process.env.RIPGREP_VERSION || 'v15.0.1'
const BIN_PATH = join(__dirname, '../bin')
const DOWNLOAD_ATTEMPTS = Number(process.env.RIPGREP_DOWNLOAD_RETRIES || '3')

function rewriteDownloadUrl(url) {
  const mirror = process.env.GITHUB_DOWNLOAD_MIRROR || ''
  if (!mirror) return url

  const shouldRewrite =
    url.startsWith('https://github.com/') ||
    url.startsWith('https://raw.githubusercontent.com/')

  if (!shouldRewrite) return url

  return `${mirror.replace(/\/$/, '')}/${url}`
}

export const getTarget = (options = {}) => {
  const arch = options.arch ?? process.env.npm_config_arch ?? os.arch()
  const platform = options.platform ?? process.env.platform ?? os.platform()
  switch (platform) {
    case 'darwin':
      switch (arch) {
        case 'arm64':
          return 'aarch64-apple-darwin.tar.gz'
        default:
          return 'x86_64-apple-darwin.tar.gz'
      }
    case 'win32':
      switch (arch) {
        case 'x64':
          return 'x86_64-pc-windows-msvc.zip'
        case 'arm':
        case 'arm64':
          return 'aarch64-pc-windows-msvc.zip'
        default:
          return 'i686-pc-windows-msvc.zip'
      }
    case 'linux':
      switch (arch) {
        case 'x64':
          return 'x86_64-unknown-linux-musl.tar.gz'
        case 'arm':
        case 'armv7l':
          return 'arm-unknown-linux-gnueabihf.tar.gz'
        case 'arm64':
          // Like x64, use the static musl build on both glibc and musl hosts.
          return 'aarch64-unknown-linux-musl.tar.gz'
        case 'ppc64':
          return 'powerpc64le-unknown-linux-gnu.tar.gz'
        case 's390x':
          return 's390x-unknown-linux-gnu.tar.gz'
        default:
          return 'i686-unknown-linux-musl.tar.gz'
      }
    default:
      throw new Error('Unknown platform: ' + platform)
  }
}

/**
 * Downloads a file from a URL, following redirects.
 * @param {string} url
 * @param {string} outFile
 */
export const downloadFile = async (url, outFile) => {
  mkdirSync(dirname(outFile), { recursive: true })
  return new Promise((resolve, reject) => {
    const request = (reqUrl, redirects = 0) => {
      const transport = reqUrl.startsWith('http://') ? http : https
      transport
        .get(reqUrl, async (response) => {
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            response.destroy()
            if (redirects >= 10) {
              reject(new Error(`Too many redirects while downloading ${url}`))
              return
            }
            request(
              new URL(response.headers.location, reqUrl).toString(),
              redirects + 1,
            )
            return
          }
          if (response.statusCode !== 200) {
            response.destroy()
            reject(
              new Error(
                `Failed to download "${reqUrl}": HTTP ${response.statusCode}`,
              ),
            )
            return
          }
          try {
            await pipeline(response, createWriteStream(outFile))
            const expectedLength = Number(
              response.headers['content-length'] || 0,
            )
            if (expectedLength > 0) {
              const actualLength = statSync(outFile).size
              if (actualLength !== expectedLength) {
                throw new Error(
                  `Downloaded "${reqUrl}" size mismatch: expected ${expectedLength} bytes, got ${actualLength}`,
                )
              }
            }
            resolve()
          } catch (error) {
            rmSync(outFile, { force: true })
            reject(error)
          }
        })
        .on('error', reject)
    }
    request(url)
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const archiveSuffix = (fileName) => {
  if (fileName.endsWith('.tar.gz')) return '.tar.gz'
  if (fileName.endsWith('.zip')) return '.zip'
  return ''
}

const temporaryArchivePath = (cacheDir, fileName, attempt) => {
  const suffix = archiveSuffix(fileName)
  const baseName = suffix ? fileName.slice(0, -suffix.length) : fileName
  const nonce = Math.random().toString(36).slice(2)
  return join(
    cacheDir,
    `${baseName}-${process.pid}-${Date.now()}-${attempt}-${nonce}${suffix}`,
  )
}

const removeExtractedBinary = (outDir) => {
  rmSync(join(outDir, 'rg'), { force: true })
  rmSync(join(outDir, 'rg.exe'), { force: true })
}

/**
 * @param {string} inFile
 * @param {string} outDir
 */
const unzip = async (inFile, outDir) => {
  mkdirSync(outDir, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-Command',
      `Expand-Archive -Path '${inFile}' -DestinationPath '${outDir}' -Force`,
    ])
  } else {
    execFileSync('unzip', ['-o', inFile, '-d', outDir])
  }
}

/**
 * @param {string} inFile
 * @param {string} outDir
 */
const untarGz = async (inFile, outDir) => {
  mkdirSync(outDir, { recursive: true })
  execFileSync('tar', ['xf', inFile, '-C', outDir])
}

export const downloadRipGrep = async (binPath = BIN_PATH, options = {}) => {
  const target = getTarget(options)
  const url = `https://github.com/${REPOSITORY}/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${target}`

  const cacheDir = join(os.tmpdir(), 'ripgrep-cache')
  const downloadName = `ripgrep-${RIPGREP_VERSION}-${target}`
  const downloadUrl = rewriteDownloadUrl(url)
  const attempts = Math.max(1, DOWNLOAD_ATTEMPTS || 1)
  const rgName = target.endsWith('.zip') ? 'rg.exe' : 'rg'
  const rgPath = join(binPath, rgName)

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const downloadPath = temporaryArchivePath(cacheDir, downloadName, attempt)
    try {
      console.log(
        `Downloading ripgrep ${RIPGREP_VERSION} for ${target}${
          attempts > 1 ? ` (attempt ${attempt}/${attempts})` : ''
        }...`,
      )
      await downloadFile(downloadUrl, downloadPath)

      mkdirSync(binPath, { recursive: true })
      removeExtractedBinary(binPath)

      if (downloadPath.endsWith('.tar.gz')) {
        await untarGz(downloadPath, binPath)
      } else if (downloadPath.endsWith('.zip')) {
        await unzip(downloadPath, binPath)
      } else {
        throw new Error(`Invalid downloadPath ${downloadPath}`)
      }

      if (!existsSync(rgPath) || statSync(rgPath).size === 0) {
        throw new Error(`ripgrep archive did not produce ${rgPath}`)
      }

      // Ensure binary is executable
      chmodSync(rgPath, 0o755)
      rmSync(downloadPath, { force: true })
      return
    } catch (error) {
      lastError = error
      rmSync(downloadPath, { force: true })
      removeExtractedBinary(binPath)
      if (attempt < attempts) {
        console.warn(
          `Warning: ripgrep download/extract failed: ${error.message}. Retrying...`,
        )
        await sleep(500 * attempt)
      }
    }
  }

  throw lastError
}
