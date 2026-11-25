/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { splitByTables } from './markdown.js';

export function buildFeishuWebhookCard(text: string) {
  const literalMentions = text.replace(
    /<\/?at(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi,
    (tag) => tag.replaceAll('<', '&#60;').replaceAll('>', '&#62;'),
  );
  return {
    schema: '2.0',
    body: {
      elements: splitByTables(literalMentions).map((content) => ({
        tag: 'markdown',
        content,
      })),
    },
  };
}
