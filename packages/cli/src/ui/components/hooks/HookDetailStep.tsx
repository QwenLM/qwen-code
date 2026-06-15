/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HookEventDisplayInfo } from './types.js';
import { supportsMatchers } from './constants.js';
import { HookEventMatcherListStep } from './HookEventMatcherListStep.js';
import { HookEventHandlerListStep } from './HookEventHandlerListStep.js';

interface HookDetailStepProps {
  hook: HookEventDisplayInfo;
  selectedIndex: number;
}

export function HookDetailStep({
  hook,
  selectedIndex,
}: HookDetailStepProps): React.JSX.Element {
  if (supportsMatchers(hook.event)) {
    return (
      <HookEventMatcherListStep hook={hook} selectedIndex={selectedIndex} />
    );
  }
  return <HookEventHandlerListStep hook={hook} selectedIndex={selectedIndex} />;
}
