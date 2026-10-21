/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactElement,
} from 'react';
import type {
  WebShellUnavailableModel,
  WebShellUnavailableModelTooltipHandle,
  WebShellUnavailableModelTooltipMount,
} from '../unavailableModels';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
} from './ui/popover';
import styles from './UnavailableModelTooltip.module.css';

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 150;

export function UnavailableModelTooltip({
  model,
  mount,
  children,
}: {
  model: WebShellUnavailableModel;
  mount?: WebShellUnavailableModelTooltipMount;
  children: ReactElement;
}) {
  const canOpen = Boolean(mount || model.tooltip);
  const [open, setOpen] = useState(false);
  const id = useId();
  const anchorRef = useRef<ComponentRef<typeof PopoverAnchor>>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const active = useRef<
    | {
        mount: WebShellUnavailableModelTooltipMount;
        handle: WebShellUnavailableModelTooltipHandle;
      }
    | undefined
  >(undefined);
  const [fallbackText, setFallbackText] = useState<string | null>(
    model.tooltip ?? null,
  );

  useEffect(
    () => () => {
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    },
    [],
  );

  const cancelClose = () => clearTimeout(closeTimer.current);
  const cancelOpen = () => {
    clearTimeout(openTimer.current);
    openTimer.current = undefined;
  };
  const close = useCallback(() => {
    cancelOpen();
    cancelClose();
    setOpen(false);
  }, []);
  const containsFocus = (target: EventTarget | null) =>
    target instanceof Node &&
    (anchorRef.current?.contains(target) ||
      contentRef.current?.contains(target));
  const getActiveElement = () => {
    let activeElement = anchorRef.current?.ownerDocument.activeElement ?? null;
    while (activeElement?.shadowRoot?.activeElement) {
      activeElement = activeElement.shadowRoot.activeElement;
    }
    return activeElement;
  };
  const closeAfterDelay = () => {
    cancelOpen();
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!containsFocus(getActiveElement())) close();
    }, CLOSE_DELAY_MS);
  };

  const disposeHost = useCallback(() => {
    const previous = active.current;
    active.current = undefined;
    if (!previous) return;
    try {
      previous.handle.dispose();
    } finally {
      hostRef.current?.replaceChildren();
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      disposeHost();
      return;
    }
    const container = hostEl;
    if (!container) return;
    if (!mount) {
      disposeHost();
      setFallbackText(model.tooltip ?? null);
      return;
    }
    try {
      const existing = active.current;
      if (existing && existing.mount === mount) {
        existing.handle.update({ model });
        setFallbackText(null);
        return;
      }
      disposeHost();
      const handle = mount(container, { model });
      if (handle == null) {
        setFallbackText(model.tooltip ?? null);
        return;
      }
      if (
        typeof handle.update !== 'function' ||
        typeof handle.dispose !== 'function'
      ) {
        if (typeof handle.dispose === 'function') handle.dispose();
        throw new Error(
          'Unavailable model tooltip mount must return update and dispose methods',
        );
      }
      active.current = { mount, handle };
      setFallbackText(null);
    } catch {
      disposeHost();
      setFallbackText(model.tooltip ?? null);
    }
  }, [disposeHost, hostEl, mount, model, open]);

  useLayoutEffect(() => disposeHost, [disposeHost]);

  if (!canOpen) return children;

  const showFallback = fallbackText != null && fallbackText !== '';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverAnchor
        asChild
        ref={anchorRef}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onPointerMove={(event) => {
          if (event.pointerType === 'touch') return;
          cancelClose();
          if (event.buttons !== 0 || open || openTimer.current !== undefined)
            return;
          openTimer.current = setTimeout(() => {
            openTimer.current = undefined;
            setOpen(true);
          }, OPEN_DELAY_MS);
        }}
        onPointerLeave={closeAfterDelay}
        onFocus={() => {
          cancelOpen();
          cancelClose();
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!containsFocus(event.relatedTarget)) closeAfterDelay();
        }}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        id={id}
        ref={contentRef}
        side="right"
        align="start"
        sideOffset={10}
        collisionPadding={8}
        className={styles.card}
        data-web-shell-unavailable-model-tooltip=""
        data-web-shell-toolbar-popover=""
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={closeAfterDelay}
        onFocus={cancelClose}
        onBlur={(event) => {
          if (!containsFocus(event.relatedTarget)) closeAfterDelay();
        }}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <PopoverHeader className={styles.header}>
          <PopoverTitle data-web-shell-unavailable-model-title="">
            {model.label ?? model.id}
          </PopoverTitle>
          {showFallback ? (
            <PopoverDescription>{fallbackText}</PopoverDescription>
          ) : null}
        </PopoverHeader>
        <div
          ref={(node) => {
            hostRef.current = node;
            setHostEl(node);
          }}
          className={styles.host}
          hidden={showFallback}
          data-web-shell-unavailable-model-host=""
        />
      </PopoverContent>
    </Popover>
  );
}
