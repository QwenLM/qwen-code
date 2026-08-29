import * as React from 'react';
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

const TooltipTrigger = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentProps<typeof TooltipPrimitive.Trigger>
>(function TooltipTrigger(props, ref) {
  return (
    <TooltipPrimitive.Trigger
      ref={ref}
      data-slot="tooltip-trigger"
      {...props}
    />
  );
});

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentProps<typeof TooltipPrimitive.Content>
>(function TooltipContent(
  { className, sideOffset = 0, children, ...props },
  ref,
) {
  const portalRoot = useWebShellPortalRoot();
  return (
    <TooltipPrimitive.Portal container={portalRoot ?? undefined}>
      <TooltipPrimitive.Content
        ref={ref}
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'relative z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10 [--floating-arrow-offset:-1px] data-[side=top]:[--floating-arrow-offset:0px] has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          data-slot="tooltip-arrow"
          asChild
          width={12}
          height={6}
        >
          <svg
            viewBox="0 0 30 10"
            style={{ transform: 'translateY(var(--floating-arrow-offset))' }}
            aria-hidden="true"
          >
            <path className="fill-popover" d="M0 0h30L15 10Z" />
            <path
              className="fill-none stroke-border"
              d="M.5 0 15 9.5 29.5 0"
              strokeWidth={1}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </TooltipPrimitive.Arrow>
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
});

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
