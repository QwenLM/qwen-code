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
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !enabled) {
      return;
    }

    const measure = () => {
      const active = list.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]',
      );
      if (!active) {
        setStyle((previous) => ({ ...previous, opacity: 0 }));
        return;
      }
      setStyle({
        left: active.offsetLeft,
        top: active.offsetTop,
        width: active.offsetWidth,
        height: active.offsetHeight,
        opacity: 1,
      });
    };

    measure();
    // Transitions arm after the first paint so the initial position snaps
    // instead of sliding in from the origin.
    const frame = requestAnimationFrame(() => setReady(true));

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(list, {
      attributes: true,
      attributeFilter: ['data-state'],
      childList: true,
      subtree: true,
    });
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(list);

    return () => {
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [listRef, enabled]);

  return { style, ready };
}

type TabsListProps = ComponentPropsWithoutRef<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>;

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(function TabsList(
  { className, variant = 'default', children, ...props },
  forwardedRef,
) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const { style, ready } = useSlidingIndicator(listRef, variant === 'default');

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
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    >
      {variant === 'default' && (
        <span
          data-slot="tabs-list-indicator"
          aria-hidden
          className={cn(
            'absolute rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30',
            ready &&
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
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-all group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
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
