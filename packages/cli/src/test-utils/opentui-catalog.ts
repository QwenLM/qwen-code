/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import * as React from 'react';

type Listener<T = unknown> = (event: T) => void;
export const catalogNativeCore = {
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
  decodePasteBytes: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
};

export function catalogRuntime(caret = false, scrollBy?: () => void) {
  const Scroll = React.forwardRef<unknown, { children?: React.ReactNode }>(
    (props, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollBy }));
      return React.createElement('div', null, props.children);
    },
  );
  Scroll.displayName = 'Scroll';
  const jsx = (
    type: unknown,
    props: Record<string, unknown> | null,
    key?: React.Key,
  ) => {
    if (type === 'scrollbox' && scrollBy)
      return React.createElement(Scroll, { ...props, key });
    if (type === 'markdown')
      return React.createElement('div', { key }, props?.['content'] as string);
    if (type === 'box' || type === 'text' || type === 'scrollbox')
      return React.createElement(
        type === 'text' ? 'span' : 'div',
        {
          key,
          ...(caret
            ? { 'data-caret': props?.['bg'] === undefined ? undefined : 'true' }
            : {}),
        },
        props?.['children'] as React.ReactNode,
      );
    return React.createElement(type as React.ElementType, { ...props, key });
  };
  return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
}

export function catalogAppContext<T>(keyboard: Array<Listener<T>>) {
  const keyHandler = {
    on: (_event: string, listener: Listener<T>) => {
      keyboard.push(listener);
    },
    off: (_event: string, listener: Listener<T>) => {
      const index = keyboard.indexOf(listener);
      if (index >= 0) keyboard.splice(index, 1);
    },
  };
  return () => ({ keyHandler });
}

export function catalogHooks(
  keyboard: Listener[],
  paste: Listener[],
  dimensions: () => { width: number; height: number },
) {
  function useListener(list: Listener[], handler: Listener) {
    const ref = React.useRef(handler);
    ref.current = handler;
    React.useEffect(() => {
      const entry = (event: unknown) => ref.current(event);
      list.push(entry);
      return () => {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      };
    }, [list]);
  }
  return {
    useAppContext: catalogAppContext(keyboard),
    useKeyboard: (handler: Listener) => useListener(keyboard, handler),
    usePaste: (handler: Listener) => useListener(paste, handler),
    useTerminalDimensions: dimensions,
  };
}

export function catalogKey(
  name: string,
  sequence: string,
  eventType = 'press',
) {
  return {
    name,
    sequence,
    eventType,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    preventDefault() {},
    stopPropagation() {},
  };
}

export function catalogDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
