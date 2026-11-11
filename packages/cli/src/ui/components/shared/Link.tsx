/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

// Thin wrapper around the `ink-link` intrinsic so plugin packages can render
// terminal hyperlinks without needing the engine's JSX.IntrinsicElements
// augmentation (declared in `../../../ink/types.d.ts`), which only applies
// inside this package's own compilation.
export function Link({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return <ink-link href={href}>{children}</ink-link>;
}
