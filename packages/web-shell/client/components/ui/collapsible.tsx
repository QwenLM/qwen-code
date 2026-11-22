'use client';

import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

const Collapsible = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>
>(function Collapsible(props, ref) {
  return (
    <CollapsiblePrimitive.Root ref={ref} data-slot="collapsible" {...props} />
  );
});

const CollapsibleTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(function CollapsibleTrigger(props, ref) {
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      data-slot="collapsible-trigger"
      {...props}
    />
  );
});

const CollapsibleContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(function CollapsibleContent(props, ref) {
  return (
    <CollapsiblePrimitive.Content
      ref={ref}
      data-slot="collapsible-content"
      {...props}
    />
  );
});

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
