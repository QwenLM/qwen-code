/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { WarningMessage } from './messages/WarningMessage.js';

interface McpAuthHeaderNoticeProps {
  message: string | null;
}

export const McpAuthHeaderNotice: React.FC<McpAuthHeaderNoticeProps> = ({
  message,
}) => {
  if (!message) return null;
  return <WarningMessage text={message} />;
};
