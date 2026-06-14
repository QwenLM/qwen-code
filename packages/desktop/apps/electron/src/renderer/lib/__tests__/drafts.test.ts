import { describe, expect, it } from 'bun:test'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import {
  CONTENT_PERSIST_CAP,
  attachmentFromContentRef,
  isAbsolutePath,
  toDraftRef,
} from '../drafts'

function makeAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return {
    type: 'image',
    path: '/tmp/foo.png',
    name: 'foo.png',
    mimeType: 'image/png',
    size: 4,
    base64: 'AAAA',
    thumbnailBase64: 'TTTT',
    ...overrides,
  }
}

describe('isAbsolutePath', () => {
  it('accepts POSIX absolute paths', () => {
    expect(isAbsolutePath('/tmp/foo.png')).toBe(true)
    expect(isAbsolutePath('/Users/me/a.txt')).toBe(true)
  })

  it('accepts Windows drive-letter paths', () => {
    expect(isAbsolutePath('C:\\Users\\me\\a.txt')).toBe(true)
    expect(isAbsolutePath('D:/data/file.pdf')).toBe(true)
  })

  it('rejects filename-only / relative / empty paths', () => {
    expect(isAbsolutePath('image.png')).toBe(false)
    expect(isAbsolutePath('./image.png')).toBe(false)
    expect(isAbsolutePath('foo/bar.txt')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('toDraftRef', () => {
  it('emits path-only ref for attachments with absolute paths (Track P)', () => {
    const ref = toDraftRef(makeAttachment({ path: '/Users/me/pic.png', name: 'pic.png' }))
    expect(ref).toEqual({ path: '/Users/me/pic.png', name: 'pic.png' })
  })

  it('embeds content for synthetic-path attachments (Track C)', () => {
    const ref = toDraftRef(makeAttachment({
      path: 'pasted-image-1.png',
      name: 'pasted-image-1.png',
      base64: 'AAAA',
      text: undefined,
    }))
    expect(ref).toEqual({
      path: 'pasted-image-1.png',
      name: 'pasted-image-1.png',
      content: {
        type: 'image',
        mimeType: 'image/png',
        size: 4,
        base64: 'AAAA',
        thumbnailBase64: 'TTTT',
      },
    })
  })

  it('preserves text content for text-only attachments', () => {
    const ref = toDraftRef({
      type: 'text',
      path: 'pasted.txt',
      name: 'pasted.txt',
      mimeType: 'text/plain',
      size: 5,
      text: 'hello',
    })
    expect(ref).toEqual({
      path: 'pasted.txt',
      name: 'pasted.txt',
      content: { type: 'text', mimeType: 'text/plain', size: 5, text: 'hello' },
    })
  })

  it('returns null when Track C content exceeds the per-attachment cap', () => {
    // 1.34× the cap in base64 chars → decoded bytes exceed the 20 MB cap
    const oversized = 'A'.repeat(Math.ceil(CONTENT_PERSIST_CAP / 0.75) + 1)
    const ref = toDraftRef(makeAttachment({
      path: 'huge.png',
      name: 'huge.png',
      base64: oversized,
      size: oversized.length,
    }))
    expect(ref).toBeNull()
  })

  it('does NOT apply the cap to Track P refs (path-only, cheap to persist)', () => {
    const oversized = 'A'.repeat(Math.ceil(CONTENT_PERSIST_CAP / 0.75) + 1)
    const ref = toDraftRef(makeAttachment({
      path: '/Users/me/huge.png',
      name: 'huge.png',
      base64: oversized,
      size: oversized.length,
    }))
    // Track P: just path+name, content never inlined — cap doesn't apply
    expect(ref).toEqual({ path: '/Users/me/huge.png', name: 'huge.png' })
  })
})

describe('attachmentFromContentRef', () => {
  it('reconstructs an image FileAttachment from a content-backed ref', () => {
    const restored = attachmentFromContentRef({
      path: 'pasted.png',
      name: 'pasted.png',
      content: { type: 'image', mimeType: 'image/png', size: 4, base64: 'AAAA', thumbnailBase64: 'TTTT' },
    })
    expect(restored).toEqual({
      type: 'image',
      path: 'pasted.png',
      name: 'pasted.png',
      mimeType: 'image/png',
      size: 4,
      base64: 'AAAA',
      text: undefined,
      thumbnailBase64: 'TTTT',
    })
  })

  it('returns null for refs without content (Track P case — caller must use RPC instead)', () => {
    const restored = attachmentFromContentRef({ path: '/Users/me/a.png', name: 'a.png' })
    expect(restored).toBeNull()
  })
})
