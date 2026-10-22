import { forwardRef } from 'react';
import * as ResizablePrimitive from 'react-resizable-panels';
import { cn } from '../../lib/utils';

const ResizablePanelGroup = forwardRef<
  HTMLDivElement,
  Omit<ResizablePrimitive.GroupProps, 'elementRef'>
>(({ className, ...props }, ref) => (
  <ResizablePrimitive.Group
    data-slot="resizable-panel-group"
    className={cn('flex h-full w-full', className)}
    {...props}
    elementRef={ref}
  />
));
ResizablePanelGroup.displayName = 'ResizablePanelGroup';

const ResizablePanel = forwardRef<
  HTMLDivElement,
  Omit<ResizablePrimitive.PanelProps, 'elementRef'>
>((props, ref) => (
  <ResizablePrimitive.Panel
    data-slot="resizable-panel"
    {...props}
    elementRef={ref}
  />
));
ResizablePanel.displayName = 'ResizablePanel';

const ResizableHandle = forwardRef<
  HTMLDivElement,
  Omit<ResizablePrimitive.SeparatorProps, 'elementRef'>
>(({ className, ...props }, ref) => (
  <ResizablePrimitive.Separator
    data-slot="resizable-handle"
    className={cn(
      'relative w-px shrink-0 bg-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
      className,
    )}
    {...props}
    elementRef={ref}
  />
));
ResizableHandle.displayName = 'ResizableHandle';

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
