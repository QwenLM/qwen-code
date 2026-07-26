import type * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { useWebShellPortalRoot } from '../../portalRoot';

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const portalRoot = useWebShellPortalRoot();
  return (
    <TooltipPrimitive.Portal container={portalRoot ?? undefined}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "relative z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md border border-border bg-popover px-3 py-1.5 text-xs text-popover-foreground before:pointer-events-none before:absolute before:size-2.5 before:rotate-45 before:rounded-[2px] before:bg-popover before:border-border before:content-[''] has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:before:-top-[5px] data-[side=bottom]:before:left-1/2 data-[side=bottom]:before:-translate-x-1/2 data-[side=bottom]:before:border-t data-[side=bottom]:before:border-l data-[side=left]:before:top-1/2 data-[side=left]:before:-right-[5px] data-[side=left]:before:-translate-y-1/2 data-[side=left]:before:border-t data-[side=left]:before:border-r data-[side=right]:before:top-1/2 data-[side=right]:before:-left-[5px] data-[side=right]:before:-translate-y-1/2 data-[side=right]:before:border-b data-[side=right]:before:border-l data-[side=top]:before:-bottom-[6px] data-[side=top]:before:left-1/2 data-[side=top]:before:-translate-x-1/2 data-[side=top]:before:border-r data-[side=top]:before:border-b data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
