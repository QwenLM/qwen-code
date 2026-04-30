import { Extension, type Editor as CoreEditor } from '@tiptap/core'
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { isSlashSuggestionActive } from '../TiptapSlashMenu'
import { RICH_BLOCK_EDIT_EVENT } from '../rich-block-events'

const RICH_BLOCK_NODES = new Set(['image', 'mermaidBlock', 'latexBlock'])
const EDITABLE_RICH_BLOCK_NODES = new Set(['mermaidBlock', 'latexBlock'])
const INLINE_MATH_EDIT_EVENT = 'inlineMathEdit'
const RICH_BLOCK_SELECTION_HIGHLIGHT_KEY = new PluginKey<{ suspendDuringPointerDrag: boolean }>('richBlockSelectionHighlight')

function isRichBlockNode(node: { type?: { name?: string } } | null | undefined): boolean {
  return node?.type?.name != null && RICH_BLOCK_NODES.has(node.type.name)
}

function isEditableRichBlockNode(node: { type?: { name?: string } } | null | undefined): boolean {
  return node?.type?.name != null && EDITABLE_RICH_BLOCK_NODES.has(node.type.name)
}

function syncImageLoadingState(root: ParentNode): void {
  const images = root.querySelectorAll('img[src]')

  images.forEach((img) => {
    const image = img as HTMLImageElement
    const src = image.currentSrc || image.src
    if (!src) return

    const markLoaded = (loadedSrc: string) => {
      image.dataset.loading = 'false'
      image.dataset.loadTrackedSrc = loadedSrc
    }

    if (image.complete) {
      markLoaded(src)
      return
    }

    image.dataset.loading = 'true'

    if (image.dataset.loadTrackedSrc === src) return

    image.dataset.loadTrackedSrc = src

    const handleDone = () => {
      const latestSrc = image.currentSrc || image.src
      if (latestSrc !== src) return
      markLoaded(src)
    }

    image.addEventListener('load', handleDone, { once: true })
    image.addEventListener('error', handleDone, { once: true })
  })
}

export const RichBlockInteractions = Extension.create({
  name: 'richBlockInteractions',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: RICH_BLOCK_SELECTION_HIGHLIGHT_KEY,
        state: {
          init: () => ({ suspendDuringPointerDrag: false }),
          apply(tr, prev) {
            const meta = tr.getMeta(RICH_BLOCK_SELECTION_HIGHLIGHT_KEY) as { suspendDuringPointerDrag?: boolean } | undefined
            if (typeof meta?.suspendDuringPointerDrag === 'boolean' && meta.suspendDuringPointerDrag !== prev.suspendDuringPointerDrag) {
              return { suspendDuringPointerDrag: meta.suspendDuringPointerDrag }
            }
            return prev
          },
        },
        view: (view) => {
          let pointerDown = false

          const setSuspendDuringPointerDrag = (suspendDuringPointerDrag: boolean) => {
            const pluginState = RICH_BLOCK_SELECTION_HIGHLIGHT_KEY.getState(view.state) as { suspendDuringPointerDrag: boolean } | undefined
            if (pluginState?.suspendDuringPointerDrag === suspendDuringPointerDrag) return
            view.dispatch(view.state.tr.setMeta(RICH_BLOCK_SELECTION_HIGHLIGHT_KEY, { suspendDuringPointerDrag }))
          }

          const handleMouseDownCapture = (event: MouseEvent) => {
            if (event.button !== 0) return
            pointerDown = true
            setSuspendDuringPointerDrag(true)
          }

          const handlePointerUp = () => {
            if (!pointerDown) return
            pointerDown = false
            setSuspendDuringPointerDrag(false)
          }

          view.dom.addEventListener('mousedown', handleMouseDownCapture, true)
          view.dom.ownerDocument.addEventListener('mouseup', handlePointerUp, true)
          view.dom.ownerDocument.addEventListener('dragend', handlePointerUp, true)

          return {
            destroy: () => {
              view.dom.removeEventListener('mousedown', handleMouseDownCapture, true)
              view.dom.ownerDocument.removeEventListener('mouseup', handlePointerUp, true)
              view.dom.ownerDocument.removeEventListener('dragend', handlePointerUp, true)
            },
          }
        },
        props: {
          decorations(state) {
            const pluginState = RICH_BLOCK_SELECTION_HIGHLIGHT_KEY.getState(state) as { suspendDuringPointerDrag: boolean } | undefined
            if (pluginState?.suspendDuringPointerDrag) return DecorationSet.empty

            const { from, to } = state.selection
            if (from === to) return DecorationSet.empty
            if (state.selection instanceof NodeSelection) return DecorationSet.empty

            const decorations: Decoration[] = []
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (isRichBlockNode(node)) {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-selected' }))
              }
              if (node.type.name === 'inlineMath') {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'is-selected' }))
              }
            })

            return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty
          },

          handleTextInput: (view) => {
            const { selection } = view.state
            if (!(selection instanceof NodeSelection)) return false
            if (!isEditableRichBlockNode(selection.node)) return false

            ;(this.editor as any).emit(RICH_BLOCK_EDIT_EVENT)
            return true
          },

          handleKeyDown: (view, event) => {
            if (event.key === 'Enter') {
              const { selection } = view.state
              if (selection instanceof NodeSelection && selection.node.type.name === 'inlineMath') {
                event.preventDefault()
                ;(this.editor as any).emit(INLINE_MATH_EDIT_EVENT)
                return true
              }
              if (selection instanceof NodeSelection && isEditableRichBlockNode(selection.node)) {
                event.preventDefault()
                ;(this.editor as any).emit(RICH_BLOCK_EDIT_EVENT)
                return true
              }
              return false
            }

            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false
            if (isSlashSuggestionActive(this.editor as CoreEditor)) return false

            const down = event.key === 'ArrowDown'
            const { state } = view
            const { selection, doc } = state

            if (selection instanceof NodeSelection && isRichBlockNode(selection.node)) {
              event.preventDefault()

              if (down) {
                const afterPos = selection.to
                if (afterPos >= doc.content.size) return true
                const next = doc.nodeAt(afterPos)
                if (isRichBlockNode(next)) {
                  this.editor.commands.setNodeSelection(afterPos)
                } else {
                  this.editor.commands.setTextSelection(afterPos)
                }
              } else {
                const beforePos = selection.from
                if (beforePos <= 0) return true
                const $before = doc.resolve(beforePos)
                const prev = $before.nodeBefore
                if (isRichBlockNode(prev) && prev) {
                  this.editor.commands.setNodeSelection(beforePos - prev.nodeSize)
                } else {
                  this.editor.commands.setTextSelection(beforePos)
                }
              }
              return true
            }

            if (!selection.empty) return false
            const $head = selection.$head
            if ($head.depth < 1) return false
            if (!view.endOfTextblock(down ? 'down' : 'up')) return false

            if (down) {
              const afterPos = $head.after()
              if (afterPos >= doc.content.size) return false
              const next = doc.nodeAt(afterPos)
              if (!isRichBlockNode(next)) return false
              event.preventDefault()
              this.editor.commands.setNodeSelection(afterPos)
              return true
            }

            const beforePos = $head.before()
            if (beforePos <= 0) return false
            const $before = doc.resolve(beforePos)
            const prev = $before.nodeBefore
            if (!isRichBlockNode(prev) || !prev) return false
            event.preventDefault()
            this.editor.commands.setNodeSelection(beforePos - prev.nodeSize)
            return true
          },
        },
      }),
      new Plugin({
        key: new PluginKey('richBlockImageLoadingState'),
        view: (view) => {
          const updateLoadingState = () => syncImageLoadingState(view.dom)
          updateLoadingState()

          return {
            update: () => updateLoadingState(),
          }
        },
      }),
    ]
  },
})
