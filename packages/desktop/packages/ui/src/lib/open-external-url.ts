/**
 * Browser-side external URL opener for WebUI and Viewer.
 *
 * `window.open(url, '_blank', 'noopener,noreferrer')` is unreliable for
 * non-http schemes in cross-origin HTTPS contexts: Chrome opens a
 * detached tab that never hits the external-protocol dispatcher, and
 * the URL ends up rewritten relative to the current origin (e.g.
 * `https://<host>/obsidian://foo` → 404).
 *
 * An ordinary anchor click on a real `<a>` in the DOM does go through
 * the link-navigation path, which triggers the OS protocol handler
 * prompt. We keep `window.open` for http/https so the new-tab UX is
 * identical to today.
 */

import {
  classifyExternalUrl,
  type UrlClassification,
} from '@craft-agent/shared/utils/url-safety'

export type OpenExternalUrlResult =
  | { opened: true }
  | { opened: false; reason: 'dangerous'; detail: string }
  | { opened: false; reason: 'internal-deeplink' }
  | { opened: false; reason: 'malformed' }

export function openExternalUrl(rawUrl: string): OpenExternalUrlResult {
  const classification: UrlClassification = classifyExternalUrl(rawUrl)

  if (classification.kind === 'dangerous') {
    return { opened: false, reason: 'dangerous', detail: classification.reason }
  }

  if (classification.kind === 'internal-deeplink') {
    return { opened: false, reason: 'internal-deeplink' }
  }

  const url = rawUrl.trim()

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { opened: false, reason: 'malformed' }
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    window.open(url, '_blank', 'noopener,noreferrer')
    return { opened: true }
  }

  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
  return { opened: true }
}
