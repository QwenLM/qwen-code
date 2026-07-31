/**
 * Shared browser component utilities
 */

export function getHostname(url: string): string {
  try {
    if (url === 'about:blank' || !url) return 'New Tab'
    const parsed = new URL(url)

    if (parsed.protocol === 'file:') {
      const decodedPath = decodeURIComponent(parsed.pathname || '')
      if (!decodedPath || decodedPath === '/' || decodedPath.endsWith('/')) return 'Local File'

      const normalizedPath = decodedPath.replace(/\/+$/, '')
      const fileName = normalizedPath.split('/').filter(Boolean).at(-1)
      return fileName || 'Local File'
    }

    const hostname = parsed.hostname.replace(/^www\./, '')
    if (hostname) return hostname

    return parsed.protocol.replace(/:$/, '') || url
  } catch {
    return url
  }
}

/**
 * Compute relative luminance of a CSS color string.
 * Uses a hidden probe element to resolve any CSS color format to RGB,
 * then applies the WCAG luminance formula.
 * Results are cached for performance.
 */
const themeLuminanceCache = new Map<string, number | null>()

export function getThemeLuminance(color: string): number | null {
  if (typeof document === 'undefined' || !document.body) return null

  const cached = themeLuminanceCache.get(color)
  if (cached !== undefined) return cached

  const probe = document.createElement('span')
  probe.style.color = color
  probe.style.position = 'absolute'
  probe.style.opacity = '0'
  probe.style.pointerEvents = 'none'
  probe.style.left = '-9999px'
  document.body.appendChild(probe)

  const computed = getComputedStyle(probe).color
  probe.remove()

  const match = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/)
  if (!match) {
    themeLuminanceCache.set(color, null)
    return null
  }

  const toLinear = (channel: number) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }

  const r = toLinear(Number(match[1]))
  const g = toLinear(Number(match[2]))
  const b = toLinear(Number(match[3]))

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  themeLuminanceCache.set(color, luminance)
  return luminance
}
