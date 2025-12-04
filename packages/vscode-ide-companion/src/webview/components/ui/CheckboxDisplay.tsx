/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

export interface CheckboxDisplayProps {
  checked?: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

/**
 * Display-only checkbox styled via Tailwind classes.
 * - Renders a custom-looking checkbox using appearance-none and pseudo-elements.
 * - Supports indeterminate (middle) state using the DOM property and a data- attribute.
 * - Intended for read-only display (disabled by default).
 */
export const CheckboxDisplay: React.FC<CheckboxDisplayProps> = ({
  checked = false,
  indeterminate = false,
  disabled = true,
  className = '',
  style,
  title,
}) => {
  const ref = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    el.indeterminate = !!indeterminate;
    if (indeterminate) {
      el.setAttribute('data-indeterminate', 'true');
    } else {
      el.removeAttribute('data-indeterminate');
    }
  }, [indeterminate, checked]);

  return (
    <input
      ref={ref}
      type="checkbox"
      disabled={disabled}
      checked={checked}
      readOnly
      aria-checked={indeterminate ? 'mixed' : checked}
      title={title}
      style={style}
      className={[
        // Base box style (equivalent to .q)
        'q appearance-none m-[2px] shrink-0 w-4 h-4 relative rounded-[2px] box-border',
        'border border-[var(--app-input-border)] bg-[var(--app-input-background)] text-[var(--app-primary-foreground)]',
        'inline-flex items-center justify-center',
        // Checked visual state
        'checked:opacity-70 checked:text-[#74c991]',
        // Checkmark / indeterminate symbol via pseudo-element
        'after:absolute after:left-1/2 after:top-1/2 after:-translate-x-1/2 after:-translate-y-1/2 after:opacity-0 after:pointer-events-none after:antialiased',
        'checked:after:content-["\\2713"] checked:after:text-[0.9em] checked:after:opacity-100',
        'data-[indeterminate=true]:text-[#e1c08d] data-[indeterminate=true]:after:content-["\\273d"] data-[indeterminate=true]:after:text-[0.8em] data-[indeterminate=true]:after:opacity-100',
        className,
      ].join(' ')}
    />
  );
};
