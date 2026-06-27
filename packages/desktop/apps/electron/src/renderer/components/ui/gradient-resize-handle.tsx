import * as React from "react"
import * as ResizablePrimitive from "react-resizable-panels"
import { cn } from "@/lib/utils"
import { useResizeGradient } from "@/hooks/useResizeGradient"

interface GradientResizeHandleProps {
  className?: string
  /** Height at which to place horizontal connector line (matches header separator) */
  headerHeight?: number
}

/**
 * GradientResizeHandle - A resize handle with a gradient indicator that follows the cursor
 *
 * Features:
 * - 12px touch area (±6px from center) for easy grabbing
 * - 1px static separator line (always visible, connects panels)
 * - Gradient overlay that follows cursor on hover (fades in/out over 150ms)
 * - Horizontal connector line at header height to join panel separators
 *
 * Drop-in replacement for ResizableHandle from shadcn/ui
 */
export function GradientResizeHandle({ className, headerHeight = 50 }: GradientResizeHandleProps) {
  const { ref, handlers, gradientStyle } = useResizeGradient()

  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        // 1px visual width, touch area extends via absolute positioning
        "relative flex w-px items-center justify-center",
        "border-0 shadow-none outline-none ring-0",
        "focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
        "after:hidden before:hidden",
        className
      )}
    >
      {/* Horizontal connector - joins the header separators across panels */}
      <div
        className="absolute h-px bg-border"
        style={{ top: headerHeight, left: -6, right: 0 }}
      />

      {/* Touch area container - extends 6px each side for 12px total hit area */}
      <div
        ref={ref}
        onMouseDown={handlers.onMouseDown}
        onMouseMove={handlers.onMouseMove}
        onMouseLeave={handlers.onMouseLeave}
        className="absolute inset-y-0 -left-1.5 -right-1.5 flex justify-center cursor-col-resize"
      >
        {/* Static 1px separator - always visible as panel divider */}
        <div className="w-px h-full bg-border" />

        {/* Gradient overlay - fades in on hover, positioned over the separator */}
        <div
          className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5"
          style={gradientStyle}
        />
      </div>
    </ResizablePrimitive.PanelResizeHandle>
  )
}
