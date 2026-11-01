import { describe, expect, it, vi } from 'vitest';
import { getWorkflowModeControlState } from './workflow-mode-control-state';

const availableOff = {
  requested: false,
  available: true,
  effective: false,
};

describe('getWorkflowModeControlState', () => {
  it.each([undefined, 'unsupported'] as const)('hides status %s', (status) => {
    expect(
      getWorkflowModeControlState({ workflowModeStatus: status }, 'en'),
    ).toBeNull();
  });

  it('does not reuse a saved mode before a session exists', () => {
    const control = getWorkflowModeControlState(
      {
        workflowModeStatus: 'unbound',
        workflowMode: { requested: true, available: true, effective: true },
        onWorkflowModeChange: vi.fn(),
      },
      'en',
    )!;
    expect(control.mode).toBeUndefined();
    expect(control.disabled).toBe(true);
    expect(control.description).toBe(
      'Create or resume a session to check availability.',
    );
  });

  it('allows changes only when a confirmed mode and callback are present', () => {
    const props = {
      workflowModeStatus: 'ready' as const,
      workflowMode: availableOff,
    };
    expect(getWorkflowModeControlState(props, 'en')?.disabled).toBe(true);
    expect(
      getWorkflowModeControlState(
        { ...props, onWorkflowModeChange: vi.fn() },
        'en',
      )?.disabled,
    ).toBe(false);
    const missing = getWorkflowModeControlState(
      { workflowModeStatus: 'ready', onWorkflowModeChange: vi.fn() },
      'en',
    )!;
    expect(missing.disabled).toBe(true);
    expect(missing.description).toBe('Workflow mode could not be confirmed.');
  });

  it('keeps an unavailable saved on preference and permits off', () => {
    const control = getWorkflowModeControlState(
      {
        workflowModeStatus: 'ready',
        workflowMode: {
          requested: true,
          available: false,
          effective: false,
          reason: 'workflow_unavailable',
        },
        onWorkflowModeChange: vi.fn(),
      },
      'en',
    )!;
    expect(control.mode?.requested).toBe(true);
    expect(control.disabled).toBe(false);
    expect(control.description).toContain(
      'Workflow mode is on, but currently unavailable.',
    );
    expect(control.description).toContain(
      'The Workflow tool is unavailable in this session.',
    );
  });

  it('disables enabling an unavailable mode', () => {
    const control = getWorkflowModeControlState(
      {
        workflowModeStatus: 'ready',
        workflowMode: { ...availableOff, available: false },
        onWorkflowModeChange: vi.fn(),
      },
      'en',
    )!;
    expect(control.disabled).toBe(true);
    expect(control.description).toContain(
      'Workflow mode is currently unavailable.',
    );
  });

  it.each([
    { workflowModeStatus: 'syncing' as const },
    { workflowModeStatus: 'unknown' as const },
    { workflowModeStatus: 'ready' as const, workflowModePending: true },
  ])('preserves the confirmed value while writes are disabled: %o', (state) => {
    const control = getWorkflowModeControlState(
      {
        ...state,
        workflowMode: { requested: true, available: true, effective: true },
        onWorkflowModeChange: vi.fn(),
      },
      'en',
    )!;
    expect(control.disabled).toBe(true);
    expect(control.mode?.requested).toBe(true);
  });

  it('localizes both accessible label and state description', () => {
    const control = getWorkflowModeControlState(
      {
        workflowModeStatus: 'ready',
        workflowMode: availableOff,
        onWorkflowModeChange: vi.fn(),
      },
      'zh-CN',
    )!;
    expect(control.messages.label).toBe('Workflow 模式');
    expect(control.description).toContain('Workflow 模式已关闭。');
  });
});
