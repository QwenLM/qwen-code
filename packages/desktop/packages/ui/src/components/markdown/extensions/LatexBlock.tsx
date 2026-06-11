import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'
import { MarkdownLatexBlock } from '../MarkdownLatexBlock'
import { RichBlockShell } from '../RichBlockShell'
import { RICH_BLOCK_EDIT_EVENT } from '../rich-block-events'

const LATEX_LANGUAGES = new Set(['latex', 'math', 'tex', 'katex'])

export const LatexBlock = Node.create({
  name: 'latexBlock',

  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      code: {
        default: '',
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="latex-block"]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'latex-block' })]
  },

  markdownTokenName: 'code',

  parseMarkdown: (token: any, helpers: any) => {
    if (!LATEX_LANGUAGES.has((token.lang ?? '').toLowerCase())) return []
    return helpers.createNode('latexBlock', { code: token.text ?? '' })
  },

  renderMarkdown: (node: any) => {
    const code = (node.attrs?.code ?? '').replace(/\n$/, '')
    return `\`\`\`latex\n${code}\n\`\`\``
  },

  addNodeView() {
    return ReactNodeViewRenderer(({ node, editor, getPos }) => {
      const selectNode = () => {
        const pos = getPos()
        if (typeof pos !== 'number') return
        editor.chain().focus().setNodeSelection(pos).run()
      }

      const handleEditClick = () => {
        selectNode()
        queueMicrotask(() => (editor as any).emit(RICH_BLOCK_EDIT_EVENT))
      }

      return (
        <NodeViewWrapper
          contentEditable={false}
          className="tiptap-latex-block"
          data-drag-handle
          onMouseDownCapture={(event: React.MouseEvent) => {
            if (event.button !== 0) return
            const target = event.target as HTMLElement | null
            if (target?.closest('button')) return
            event.preventDefault()
            event.stopPropagation()
            selectNode()
          }}
        >
          <RichBlockShell onEdit={handleEditClick} editTitle="Edit LaTeX">
            <MarkdownLatexBlock code={(node.attrs.code as string) ?? ''} />
          </RichBlockShell>
        </NodeViewWrapper>
      )
    })
  },
})
