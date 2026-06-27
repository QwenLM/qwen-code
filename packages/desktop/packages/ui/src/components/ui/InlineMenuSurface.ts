export interface InlineMenuSurfaceOptions<T> {
  className: string
  zIndex?: number | string
  onSelect: (item: T, index: number) => void
  render: (container: HTMLElement, items: T[], selectedIndex: number) => void
}

/**
 * Headless inline menu surface for caret-anchored menus (slash, mention, label, etc.).
 *
 * Provides:
 * - delegated click selection via data-index
 * - keyboard selection helpers
 * - scroll-follow for selected row
 * - manual positioning
 */
export class InlineMenuSurface<T> {
  readonly element: HTMLElement

  private readonly options: InlineMenuSurfaceOptions<T>

  private items: T[] = []

  private selectedIndex = 0

  constructor(options: InlineMenuSurfaceOptions<T>) {
    this.options = options

    this.element = document.createElement('div')
    this.element.className = options.className
    this.element.style.position = 'fixed'
    this.element.style.zIndex = String(options.zIndex ?? 'var(--z-panel, 50)')
    this.element.addEventListener('mousedown', this.handleMouseDown)
  }

  mount(parent: HTMLElement = document.body) {
    parent.appendChild(this.element)
  }

  update(items: T[], selectedIndex?: number) {
    this.items = items

    if (typeof selectedIndex === 'number') {
      this.selectedIndex = this.clampSelectedIndex(selectedIndex)
    } else {
      this.selectedIndex = this.clampSelectedIndex(this.selectedIndex)
    }

    this.options.render(this.element, this.items, this.selectedIndex)
    this.ensureSelectedVisible()
  }

  setSelectedIndex(next: number) {
    this.selectedIndex = this.clampSelectedIndex(next)
    this.options.render(this.element, this.items, this.selectedIndex)
    this.ensureSelectedVisible()
  }

  moveSelection(step: number) {
    if (this.items.length === 0) return

    const total = this.items.length
    const next = (this.selectedIndex + step + total) % total
    this.setSelectedIndex(next)
  }

  getSelectedItem(): T | undefined {
    return this.items[this.selectedIndex]
  }

  setPosition(top: number, left: number) {
    this.element.style.top = `${top}px`
    this.element.style.left = `${left}px`
  }

  destroy() {
    this.element.removeEventListener('mousedown', this.handleMouseDown)
    this.element.remove()
  }

  private clampSelectedIndex(index: number): number {
    if (this.items.length === 0) return 0
    if (index < 0) return 0
    if (index >= this.items.length) return this.items.length - 1
    return index
  }

  private ensureSelectedVisible() {
    const selected = this.element.querySelector<HTMLElement>('[data-index].is-selected')
    if (!selected) return

    const selectedTop = selected.offsetTop
    const selectedBottom = selectedTop + selected.offsetHeight
    const viewTop = this.element.scrollTop
    const viewBottom = viewTop + this.element.clientHeight

    if (selectedTop < viewTop) {
      this.element.scrollTop = selectedTop
      return
    }

    if (selectedBottom > viewBottom) {
      this.element.scrollTop = selectedBottom - this.element.clientHeight
    }
  }

  private handleMouseDown = (event: MouseEvent) => {
    event.preventDefault()

    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-index]')
    if (!target) return

    const index = Number(target.dataset.index ?? '-1')
    if (Number.isNaN(index) || index < 0 || index >= this.items.length) return

    this.setSelectedIndex(index)
    const item = this.items[index]
    if (!item) return
    this.options.onSelect(item, index)
  }
}
