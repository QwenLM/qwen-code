/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext, type ComponentType } from 'react';
import {
  AssistantMessage,
  type AssistantMessageProps,
} from './AssistantMessage';

type AssistantMessageRowProps = AssistantMessageProps & { messageId: string };

export const AssistantMessageComponentContext = createContext<
  ComponentType<AssistantMessageRowProps> | undefined
>(undefined);

export function AssistantMessageRow(props: AssistantMessageRowProps) {
  const Component =
    useContext(AssistantMessageComponentContext) ?? AssistantMessage;
  return <Component {...props} />;
}
