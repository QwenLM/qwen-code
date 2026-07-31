/**
 * Sortable List - Flat list drag-and-drop reordering
 *
 * Uses @dnd-kit for polished DnD with:
 * - SmartPointerSensor (5px activation distance, skips data-no-dnd elements)
 * - KeyboardSensor for accessibility
 * - DragOverlay (position:fixed) for proper z-index layering above all panels
 * - Crossfade drop animation: overlay fades out while ghost fades in
 * - Smooth sibling reflow via CSS transforms
 *
 * Usage:
 *   <SortableList items={items} onReorder={handleReorder} renderItem={renderItem} />
 */

import * as React from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
  type DropAnimation,
  type MeasuringConfiguration,
  MeasuringStrategy,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

// ============================================================
// Custom PointerSensor — skips drag activation on elements with data-no-dnd
// This allows interactive elements (e.g., chevron toggles) to receive clicks
// even when nested inside a draggable container.
// ============================================================

function hasNoDndAncestor(element: HTMLElement | null): boolean {
  while (element) {
    if (element.dataset?.noDnd === 'true') return true
    element = element.parentElement
  }
  return false
}

export class SmartPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: 'onPointerDown' as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
        // Skip drag activation if click target has data-no-dnd="true" (or any ancestor does)
        if (hasNoDndAncestor(nativeEvent.target as HTMLElement)) {
          return false
        }
        return true
      },
    },
  ]
}

// ============================================================
// Drop Animation Config
// Crossfade: overlay fades out at final position while ghost fades in.
// Creates a smooth "settle into place" feel.
// ============================================================

const DROP_DURATION = 250

const dropAnimationConfig: DropAnimation = {
  keyframes({ transform }) {
    return [
      { opacity: 1, transform: CSS.Transform.toString(transform.initial) },
      { opacity: 0, transform: CSS.Transform.toString(transform.final) },
    ]
  },
  duration: DROP_DURATION,
  easing: 'ease',
  sideEffects({ active }) {
    // Ghost fades in at new position simultaneously
    active.node.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: DROP_DURATION,
      easing: 'ease',
    })
  },
}

// Measuring config: always re-measure to support animated layouts
const measuringConfig: MeasuringConfiguration = {
  droppable: {
    strategy: MeasuringStrategy.Always,
  },
}

// ============================================================
// Types
// ============================================================

export interface SortableItemData {
  /** Unique ID for this item (used as sortable key) */
  id: string
}

interface SortableListProps<T extends SortableItemData> {
  /** Array of items to render (must have unique `id` fields) */
  items: T[]
  /** Called with the new ordered array after a drop */
  onReorder: (items: T[]) => void
  /** Render function for each item. `isDragging` is true for the active ghost, `isSorting` while any drag is active. */
  renderItem: (item: T, isDragging: boolean, isSorting: boolean) => React.ReactNode
  /** Render the drag overlay content (floating clone). Falls back to renderItem. */
  renderOverlay?: (item: T) => React.ReactNode
  /** Show DragOverlay clone while dragging (default: true) */
  showOverlay?: boolean
  /** Additional className for the list container */
  className?: string
}

// ============================================================
// SortableList Component
// ============================================================

export function SortableList<T extends SortableItemData>({
  items,
  onReorder,
  renderItem,
  renderOverlay,
  showOverlay = true,
  className,
}: SortableListProps<T>) {
  const [activeId, setActiveId] = React.useState<string | null>(null)

  // Sensors: SmartPointerSensor skips data-no-dnd elements, 5px distance threshold
  const sensors = useSensors(
    useSensor(SmartPointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor)
  )

  const activeItem = React.useMemo(
    () => items.find(item => item.id === activeId),
    [items, activeId]
  )

  const handleDragStart = React.useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }, [])

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event
    setActiveId(null)

    if (!over || active.id === over.id) return

    const oldIndex = items.findIndex(item => item.id === active.id)
    const newIndex = items.findIndex(item => item.id === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      onReorder(arrayMove(items, oldIndex, newIndex))
    }
  }, [items, onReorder])

  const handleDragCancel = React.useCallback(() => {
    setActiveId(null)
  }, [])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={measuringConfig}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        <div className={className}>
          {items.map(item => (
            <SortableItemWrapper
              key={item.id}
              id={item.id}
              isDragActive={activeId === item.id}
              hideWhileDragging={showOverlay}
            >
              {renderItem(item, activeId === item.id, activeId !== null)}
            </SortableItemWrapper>
          ))}
        </div>
      </SortableContext>

      {/* DragOverlay uses position:fixed — escapes all stacking contexts and overflow.
         Inline boxShadow avoids Tailwind CSS variable scoping issues in portals. */}
      {showOverlay && (
        <DragOverlay
          dropAnimation={dropAnimationConfig}
          style={{ zIndex: 'var(--z-floating-menu, 400)' }}
        >
          {activeItem ? (
            <div
              className="sortable-overlay rounded-[6px] bg-background"
              style={{
                boxShadow: '0 0 0 1px rgba(63, 63, 68, 0.05), 0px 15px 15px 0 rgba(34, 33, 81, 0.25)',
              }}
            >
              {renderOverlay ? renderOverlay(activeItem) : renderItem(activeItem, false, true)}
            </div>
          ) : null}
        </DragOverlay>
      )}
    </DndContext>
  )
}

// ============================================================
// SortableItemWrapper - wraps each item with useSortable
// ============================================================

interface SortableItemWrapperProps {
  id: string
  isDragActive: boolean
  hideWhileDragging: boolean
  children: React.ReactNode
}

function SortableItemWrapper({ id, isDragActive, hideWhileDragging, children }: SortableItemWrapperProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide ghost only when DragOverlay is enabled
    opacity: isDragging && hideWhileDragging ? 0 : 1,
    cursor: isDragActive ? 'grabbing' : 'grab',
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

export { arrayMove } from '@dnd-kit/sortable'
