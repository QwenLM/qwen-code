/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Backspace: 'Backspace',
  Delete: 'Delete',
  End: 'End',
  Enter: 'Enter',
  Home: 'Home',
  PageDown: 'PageDown',
  PageUp: 'PageUp',
  Space: 'Space',
  Tab: 'Tab',
};

const PUNCTUATION_KEYS: Readonly<Record<string, string>> = {
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
};

function electronKey(event: KeyboardEvent<HTMLInputElement>): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  return NAMED_KEYS[event.key] ?? PUNCTUATION_KEYS[event.code] ?? null;
}

export function acceleratorFromKeyboardEvent(
  event: KeyboardEvent<HTMLInputElement>,
): string | null {
  const key = electronKey(event);
  if (!key) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function formatAccelerator(accelerator: string): string {
  if (!accelerator) return '';
  return accelerator
    .split('+')
    .map((part) => {
      if (part === 'Command') return '⌘';
      if (part === 'Control') return '⌃';
      if (part === 'Alt') return '⌥';
      if (part === 'Shift') return '⇧';
      return part === 'Space' ? 'Space' : part;
    })
    .join('');
}

export function HotkeySetter({
  accelerator,
  disabled,
  captureLabel,
  clearLabel,
  offLabel,
  onChange,
}: {
  accelerator: string;
  disabled: boolean;
  captureLabel: string;
  clearLabel: string;
  offLabel: string;
  onChange: (accelerator: string) => Promise<void>;
}) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (capturing) inputRef.current?.focus();
  }, [capturing]);

  const commit = async (next: string) => {
    setCapturing(false);
    setError(undefined);
    setPending(true);
    try {
      await onChange(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col items-end gap-1 max-md:items-start">
      <div className="flex items-center gap-2">
        {capturing ? (
          <Input
            ref={inputRef}
            readOnly
            aria-label={captureLabel}
            value={captureLabel}
            className="w-40"
            onBlur={() => setCapturing(false)}
            onKeyDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === 'Escape') {
                setCapturing(false);
                return;
              }
              if (event.repeat) return;
              const next = acceleratorFromKeyboardEvent(event);
              if (next) void commit(next);
            }}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || pending}
            aria-label={captureLabel}
            onClick={() => {
              setError(undefined);
              setCapturing(true);
            }}
          >
            {accelerator ? formatAccelerator(accelerator) : offLabel}
          </Button>
        )}
        {accelerator && !capturing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || pending}
            onClick={() => void commit('')}
          >
            {clearLabel}
          </Button>
        ) : null}
      </div>
      {error ? (
        <span className="max-w-72 text-right text-xs text-destructive max-md:text-left">
          {error}
        </span>
      ) : null}
    </div>
  );
}
