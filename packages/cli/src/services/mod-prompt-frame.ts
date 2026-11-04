/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModQueuedPrompt } from '@qwen-code/qwen-code-core/mods/types.js';

const OPEN = '<qwen:mod-prompt';
const CLOSE = '</qwen:mod-prompt>';

/**
 * The text the model reads for a prompt a Mod submitted with
 * `$.prompt.submit`. The model is told which Mod sent it and that the person
 * did not type it, unless the Mod submitted it as the person's own words
 * (`asUser`), which the model reads as it is.
 */
export function frameModPrompt(prompt: ModQueuedPrompt): string {
  if (prompt.asUser) return prompt.text;
  // A closing marker inside the text would end the block early.
  const body = prompt.text.split(CLOSE).join('<\\/qwen:mod-prompt>');
  const name = JSON.stringify(prompt.plugin);
  return [
    `${OPEN} mod=${name}>`,
    body,
    CLOSE,
    `The ${name} Mod, an extension the user installed, sent the message above while the session was idle; the user did not type it. Act on it as a request made on the user's behalf, within what the user has asked for and allowed. Only the block's own closing marker ends it.`,
  ].join('\n');
}
