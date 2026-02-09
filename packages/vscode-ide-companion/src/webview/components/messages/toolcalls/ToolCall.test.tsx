/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '../../../test-utils/render.js';
import { ToolCall } from './ToolCall.js';
import { getToolCallComponent, ToolCallRouter } from './index.js';
import {
  ReadToolCall,
  ShellToolCall,
  UpdatedPlanToolCall,
  GenericToolCall,
  type ToolCallData,
} from '@qwen-code/webui';

vi.mock('@qwen-code/webui', () => {
  const make = (id: string) => {
    const Component = (props: { toolCall: { kind: string } }) => (
      <div data-testid={id}>{props.toolCall.kind}</div>
    );
    Component.displayName = id;
    return Component;
  };
  return {
    shouldShowToolCall: vi.fn(() => true),
    GenericToolCall: make('generic'),
    ThinkToolCall: make('think'),
    SaveMemoryToolCall: make('save-memory'),
    EditToolCall: make('edit'),
    WriteToolCall: make('write'),
    SearchToolCall: make('search'),
    UpdatedPlanToolCall: make('updated-plan'),
    ShellToolCall: make('shell'),
    ReadToolCall: make('read'),
    WebFetchToolCall: make('fetch'),
  };
});

const baseToolCall: ToolCallData = {
  toolCallId: '1',
  kind: 'read',
  title: 'Read file',
  status: 'completed',
};

describe('ToolCall routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps tool call kind to the correct component', () => {
    expect(getToolCallComponent('read')).toBe(ReadToolCall);
    expect(getToolCallComponent('bash')).toBe(ShellToolCall);
    expect(getToolCallComponent('updated_plan')).toBe(UpdatedPlanToolCall);
    expect(getToolCallComponent('unknown')).toBe(GenericToolCall);
  });

  it('renders tool call via router when visible', () => {
    render(<ToolCallRouter toolCall={baseToolCall} />);
    expect(screen.getByTestId('read')).toBeInTheDocument();
  });

  it('renders ToolCall wrapper', () => {
    render(<ToolCall toolCall={baseToolCall} />);
    expect(screen.getByTestId('read')).toBeInTheDocument();
  });
});
