import { describe, expect, it } from 'bun:test'
import { extractMermaidSource, isMermaidFilename } from '../TiptapMarkdownEditor'

describe('tiptap mermaid input helpers', () => {
  it('detects mermaid file extensions', () => {
    expect(isMermaidFilename('diagram.mmd')).toBe(true)
    expect(isMermaidFilename('flow.MERMAID')).toBe(true)
    expect(isMermaidFilename('notes.md')).toBe(false)
    expect(isMermaidFilename('image.png')).toBe(false)
  })

  it('extracts source from fenced mermaid block', () => {
    const source = extractMermaidSource('```mermaid\ngraph TD\nA-->B\n```')
    expect(source).toBe('graph TD\nA-->B')
  })

  it('accepts raw mermaid syntax without fences', () => {
    const source = extractMermaidSource('sequenceDiagram\nA->>B: hello')
    expect(source).toBe('sequenceDiagram\nA->>B: hello')
  })

  it('accepts mermaid with leading %% directives', () => {
    const source = extractMermaidSource('%%{init: {"theme":"dark"}}%%\n\ngraph TD\nA-->B')
    expect(source).toBe('%%{init: {"theme":"dark"}}%%\n\ngraph TD\nA-->B')
  })

  it('rejects non-mermaid plain text', () => {
    const source = extractMermaidSource('This is just a normal paragraph')
    expect(source).toBeNull()
  })
})
