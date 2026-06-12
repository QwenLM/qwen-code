/**
 * Tests for linkify.ts — URL/file-path detection and markdown link preprocessing.
 *
 * Focuses on the bug where preprocessLinks() would detect bare domains inside
 * the text portion of existing markdown links (e.g. [help.figma.com - Title](url))
 * and double-wrap them, producing broken nested markdown.
 */

import { describe, it, expect } from 'bun:test'
import { preprocessLinks, detectLinks, isPlaceholderUrl, isFilePathTarget } from '../linkify'

// ============================================================================
// preprocessLinks — existing markdown links should NOT be corrupted
// ============================================================================

describe('preprocessLinks', () => {
  describe('preserves existing markdown links', () => {
    it('does not wrap a domain inside markdown link text', () => {
      const input = '- [help.figma.com - Pan and zoom in FigJam](https://help.figma.com/hc/en-us/articles/123)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('does not wrap a full URL used as link text', () => {
      const input = '[https://example.com](https://example.com)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('does not wrap the href URL of a markdown link', () => {
      const input = '[Click here](https://example.com/page)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves multiple markdown links in the same text', () => {
      const input = 'See [docs.github.com - Actions](https://docs.github.com/actions) and [api.stripe.com - Charges](https://api.stripe.com/charges)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves markdown reference links', () => {
      const input = 'Check [example.com docs][ref1] for details'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves link with domain and extra description in text', () => {
      const input = '- [stackoverflow.com - How to fix React hydration errors](https://stackoverflow.com/questions/123)'
      expect(preprocessLinks(input)).toBe(input)
    })
  })

  describe('still wraps bare URLs that are not already linked', () => {
    it('wraps a bare URL', () => {
      const input = 'Visit https://example.com for more info'
      expect(preprocessLinks(input)).toBe('Visit [https://example.com](https://example.com) for more info')
    })

    it('wraps a bare repo-relative file path', () => {
      const input = 'See apps/electron/resources/docs/browser-tools.md for details'
      expect(preprocessLinks(input)).toBe('See [apps/electron/resources/docs/browser-tools.md](apps/electron/resources/docs/browser-tools.md) for details')
    })

    it('wraps a bare domain', () => {
      const input = 'Check out example.com for details'
      expect(preprocessLinks(input)).toBe('Check out [example.com](http://example.com) for details')
    })

    it('wraps bare URL but preserves adjacent markdown link', () => {
      const input = 'See https://bare.example.com and [linked.example.com - Title](https://linked.example.com/page)'
      const result = preprocessLinks(input)
      // The bare URL should be wrapped
      expect(result).toContain('[https://bare.example.com](https://bare.example.com)')
      // The existing markdown link should be untouched
      expect(result).toContain('[linked.example.com - Title](https://linked.example.com/page)')
    })
  })

  describe('strips trailing markdown formatting from URLs', () => {
    it('does not include trailing ** from bold-wrapped URL', () => {
      const input = 'PR created: **https://github.com/lukilabs/craft-growth/pull/1363**'
      const result = preprocessLinks(input)
      expect(result).toBe('PR created: **[https://github.com/lukilabs/craft-growth/pull/1363](https://github.com/lukilabs/craft-growth/pull/1363)**')
    })

    it('does not include trailing * from italic-wrapped URL', () => {
      const input = '*https://example.com/page*'
      const result = preprocessLinks(input)
      expect(result).toBe('*[https://example.com/page](https://example.com/page)*')
    })

    it('handles bold-wrapped URL with path and trailing text', () => {
      const input = 'See **https://github.com/org/repo/pull/42** for details'
      const result = preprocessLinks(input)
      expect(result).toBe('See **[https://github.com/org/repo/pull/42](https://github.com/org/repo/pull/42)** for details')
    })
  })

  describe('does not touch links inside code blocks', () => {
    it('skips URLs in fenced code blocks', () => {
      const input = '```\nhttps://example.com\n```'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('skips URLs in inline code', () => {
      const input = 'Run `curl https://example.com` to test'
      expect(preprocessLinks(input)).toBe(input)
    })
  })
})

// ============================================================================
// preprocessLinks — strips placeholder/fabricated URLs
// ============================================================================

describe('preprocessLinks — placeholder URL stripping', () => {
  it('strips GitHub link with /... placeholder to plain text', () => {
    const input = '**[6610172ec](https://github.com/...) - feat: Browse cache (#6644)**'
    const result = preprocessLinks(input)
    expect(result).toContain('6610172ec')
    expect(result).not.toContain('https://github.com/...')
    expect(result).not.toContain('[6610172ec]')
  })

  it('strips any link with /... in the URL path', () => {
    const input = 'See [commit abc123](https://github.com/.../commit/abc123) for details'
    const result = preprocessLinks(input)
    expect(result).toBe('See commit abc123 for details')
  })

  it('strips link with /... at end of URL', () => {
    const input = 'Check [docs](https://docs.example.com/...)'
    const result = preprocessLinks(input)
    expect(result).toBe('Check docs')
  })

  it('preserves valid GitHub URLs that do not contain /...', () => {
    const input = '[PR #42](https://github.com/lukilabs/craft-agents/pull/42)'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('preserves valid URLs with actual path segments', () => {
    const input = '[Click here](https://example.com/real/path/to/page)'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('handles multiple links where some are placeholders', () => {
    const input = 'See [real link](https://github.com/org/repo/issues/1) and [fake link](https://github.com/...)'
    const result = preprocessLinks(input)
    expect(result).toContain('[real link](https://github.com/org/repo/issues/1)')
    expect(result).toContain('and fake link')
    expect(result).not.toContain('[fake link]')
  })

  it('does not strip placeholder links inside fenced code blocks', () => {
    const input = '```\n[commit](https://github.com/...)\n```'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('does not strip placeholder links inside inline code', () => {
    const input = 'Example: `[commit](https://github.com/...)`'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('preserves empty link text with placeholder URL as-is', () => {
    const input = '[](https://github.com/...)'
    expect(preprocessLinks(input)).toBe(input)
  })
})

// ============================================================================
// isPlaceholderUrl — unit tests for placeholder detection
// ============================================================================

describe('isPlaceholderUrl', () => {
  it('detects https://github.com/... as placeholder', () => {
    expect(isPlaceholderUrl('https://github.com/...')).toBe(true)
  })

  it('detects URL with /... in middle of path', () => {
    expect(isPlaceholderUrl('https://github.com/.../commit/abc')).toBe(true)
  })

  it('does not flag valid GitHub URLs', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/pull/42')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/commit/abc123')).toBe(false)
  })

  it('does not flag URLs with triple dots in query params', () => {
    expect(isPlaceholderUrl('https://example.com/search?q=test...more')).toBe(false)
  })

  it('does not flag compare URLs with two dots', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/main..feature')).toBe(false)
  })

  it('does not flag three-dot GitHub compare URLs', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/main...feature')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/v1.0.0...v2.0.0')).toBe(false)
  })
})

// ============================================================================
// detectLinks — basic detection sanity checks
// ============================================================================

describe('detectLinks', () => {
  it('detects a bare URL', () => {
    const links = detectLinks('Visit https://example.com today')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.url).toBe('https://example.com')
    expect(links[0]!.type).toBe('url')
  })

  it('detects a bare domain', () => {
    const links = detectLinks('Check example.com')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('url')
  })

  it('strips trailing ** from bold-wrapped URL', () => {
    const links = detectLinks('**https://github.com/org/repo/pull/42**')
    expect(links).toHaveLength(1)
    expect(links[0]!.url).toBe('https://github.com/org/repo/pull/42')
    expect(links[0]!.text).toBe('https://github.com/org/repo/pull/42')
  })

  it('detects file paths', () => {
    const links = detectLinks('See /Users/foo/bar.ts for details')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('/Users/foo/bar.ts')
  })

  it('detects bare repo-relative file paths', () => {
    const links = detectLinks('Open apps/electron/resources/docs/browser-tools.md')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('apps/electron/resources/docs/browser-tools.md')
  })

  it('detects parent-relative file paths', () => {
    const links = detectLinks('See ../README.md for setup steps')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('../README.md')
  })
})

describe('isFilePathTarget', () => {
  it('accepts absolute unix image paths', () => {
    expect(isFilePathTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe(true)
  })

  it('accepts parent-relative image paths', () => {
    expect(isFilePathTarget('../downloads/assets/screenshot.png')).toBe(true)
  })

  it('accepts repo-relative markdown paths', () => {
    expect(isFilePathTarget('apps/electron/resources/docs/browser-tools.md')).toBe(true)
  })

  it('rejects web URLs', () => {
    expect(isFilePathTarget('https://example.com/image.jpg')).toBe(false)
  })

  it('rejects file URLs because they are resolved by link-target.ts', () => {
    expect(isFilePathTarget('file:///Users/tester/report.xlsx')).toBe(false)
  })

  it('rejects non-file strings', () => {
    expect(isFilePathTarget('not a link at all')).toBe(false)
  })
})
