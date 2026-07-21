// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';

import { AlertDialogContent, AlertDialogOverlay } from './alert-dialog';
import { Button } from './button';
import { DialogContent, DialogOverlay } from './dialog';
import { DropdownMenuSubTrigger, DropdownMenuTrigger } from './dropdown-menu';
import { Input } from './input';
import { PopoverAnchor, PopoverContent, PopoverTrigger } from './popover';
import { SelectTrigger } from './select';

const FORWARD_REF_TYPE = Symbol.for('react.forward_ref');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('React 18 ref compatibility', () => {
  it.each([
    ['AlertDialogContent', AlertDialogContent],
    ['AlertDialogOverlay', AlertDialogOverlay],
    ['Button', Button],
    ['DialogContent', DialogContent],
    ['DialogOverlay', DialogOverlay],
    ['Input', Input],
    ['PopoverAnchor', PopoverAnchor],
    ['PopoverContent', PopoverContent],
    ['PopoverTrigger', PopoverTrigger],
    ['DropdownMenuTrigger', DropdownMenuTrigger],
    ['DropdownMenuSubTrigger', DropdownMenuSubTrigger],
    ['SelectTrigger', SelectTrigger],
  ])('%s forwards refs', (_name, Component) => {
    expect(Component).toHaveProperty('$$typeof', FORWARD_REF_TYPE);
  });

  it('forwards a Button ref to its DOM element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<Button ref={ref}>Button</Button>));
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);

    act(() => root.unmount());
    container.remove();
  });
});
