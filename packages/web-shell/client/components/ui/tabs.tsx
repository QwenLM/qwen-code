import { forwardRef, useLayoutEffect, useRef, useState } from 'react';
import type {
  ComponentProps,
  ComponentPropsWithoutRef,
  CSSProperties,
  RefObject,
} from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Tabs as TabsPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Tabs({
  className,
  orientation = 'horizontal',
  ...props
}: ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      orientation={orientation}
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        'group/tabs flex gap-2 data-horizontal:flex-col',
        className,
      )}
      {...props}
    />
  );
}

const tabsListVariants = cva(
  'group/tabs-list relative inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none',
  {
    variants: {
      variant: {
        default: 'bg-muted',
        line: 'gap-1 bg-transparent',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

// Measures the active trigger and positions the sliding pill behind it.
// MutationObserver (not the Tabs value) drives re-measurement so uncontrolled
// roots and keyboard navigation are covered; ResizeObserver keeps the pill
// glued to the trigger across container resizes.
function useSlidingIndicator(
  listRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
) {
  const [frame, setFrame] = useState<{
    style: CSSProperties;
    animate: boolean;
  }>({ style: { opacity: 0 }, animate: false });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !enabled) {
      return;
    }

    // Transitions arm one frame after the first measurable box, so the
    // initial position — and a reveal from display:none — snap instead of
    // flying in from the origin.
    let armed = false;
    let armFrame: number | undefined;
    const arm = () => {
      if (armed) {
        return;
      }
      armed = true;
      armFrame = requestAnimationFrame(() => setReady(true));
    };

    const measure = (animate: boolean) => {
      const active = list.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]',
      );
      if (!active) {
        setFrame((previous) => ({
          animate: false,
          style: { ...previous.style, opacity: 0 },
        }));
        return;
      }
      const listRect = list.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      setFrame({
        animate,
        style: {
          left: rect.left - listRect.left + list.scrollLeft,
          top: rect.top - listRect.top + list.scrollTop,
          width: rect.width,
          height: rect.height,
          // The trigger fades when disabled; inline styles beat classes, so
          // the pill's dimming has to live in the same inline write.
          opacity: active.matches(':disabled') ? 0.5 : 1,
        },
      });
      if (rect.width > 0) {
        arm();
      }
    };

    measure(false);

    const mutationObserver = new MutationObserver(() => measure(true));
    mutationObserver.observe(list, {
      attributes: true,
      attributeFilter: ['data-state', 'disabled'],
      childList: true,
      subtree: true,
    });
    // Resize-driven moves skip the transition so the pill tracks a drag 1:1
    // instead of easing toward each intermediate target.
    const resizeObserver = new ResizeObserver(() => measure(false));
    resizeObserver.observe(list);

    return () => {
      if (armFrame !== undefined) {
        cancelAnimationFrame(armFrame);
      }
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [listRef, enabled]);

  return { style: frame.style, animated: ready && frame.animate };
}

type TabsListProps = Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>,
  'asChild'
> &
  VariantProps<typeof tabsListVariants>;

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, variant, children, ...props },
  forwardedRef,
) {
  const resolvedVariant = variant ?? 'default';
  const listRef = useRef<HTMLDivElement | null>(null);
  const { style, animated } = useSlidingIndicator(
    listRef,
    resolvedVariant === 'default',
  );

  const setRefs = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (typeof forwardedRef === 'function') {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };

  return (
    <TabsPrimitive.List
      ref={setRefs}
      data-slot="tabs-list"
      data-variant={resolvedVariant}
      className={cn(tabsListVariants({ variant: resolvedVariant }), className)}
      {...props}
    >
      {resolvedVariant === 'default' && (
        <span
          data-slot="tabs-list-indicator"
          aria-hidden
          className={cn(
            'absolute rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30',
            animated &&
              'transition-[left,width,top,height] duration-200 ease-out motion-reduce:transition-none',
          )}
          style={style}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
});

function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-[calc(100%-1px)] flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        'data-active:text-foreground dark:data-active:text-foreground',
        'after:absolute after:bg-foreground after:opacity-0 after:transition-opacity group-data-horizontal/tabs:after:inset-x-0 group-data-horizontal/tabs:after:bottom-[-5px] group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-right-1 group-data-vertical/tabs:after:w-0.5 group-data-[variant=line]/tabs-list:data-active:after:opacity-100',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 text-sm outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };
