// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedRecoveryPanel } from './ManagedRecoveryPanel';

describe('ManagedRecoveryPanel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof ManagedRecoveryPanel>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
      recovery: {
        state: 'operator_required',
        reasonCode: 'recovery_evidence_unavailable',
        turnId: 'turn-one',
        nextTurnAllowed: false,
        actions: {
          recheck: true,
          cancel: false,
          continueInNewSession: true,
        },
      },
      busy: false,
      onRecheck: vi.fn(),
      onHandoff: vi.fn(),
    };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = () =>
    act(async () => {
      root.render(
        <I18nProvider language="en">
          <ManagedRecoveryPanel {...props} />
        </I18nProvider>,
      );
    });

  it('frames a closed Session as ended instead of operator work', async () => {
    props.recovery = {
      ...props.recovery,
      reasonCode: 'session_not_active',
      actions: { recheck: false, cancel: false, continueInNewSession: true },
    };
    await render();
    expect(container.textContent).toContain('This Session has ended');
    expect(container.textContent).toContain('Continue in a new Session');
    expect(container.textContent).not.toContain('operator attention');
  });

  it('explains an unavailable recheck from its error code', async () => {
    props.error = 'HTTP 409';
    props.errorCode = 'recovery_recheck_unavailable';
    await render();
    expect(container.textContent).toContain('can no longer be rechecked');
  });
});
