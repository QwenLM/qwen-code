// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { actions, ownerGuard, ownerState } = vi.hoisted(() => {
  const ownerState = { version: 0 };
  return {
    actions: {
      getAuthProviders: vi.fn(),
      installAuthProvider: vi.fn(),
    },
    ownerGuard: {
      capture: vi.fn(() => {
        const version = ownerState.version;
        return { isCurrent: () => ownerState.version === version };
      }),
    },
    ownerState,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspaceActions: () => actions,
  useDaemonSessionOwnerGuard: () => ownerGuard,
}));

const { AuthMessage } = await import('./AuthMessage');
const { I18nProvider } = await import('../../i18n');

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
  ownerState.version = 0;
  actions.getAuthProviders.mockResolvedValue({
    v: 1,
    workspaceCwd: '/workspace',
    providers: [
      {
        id: 'custom-openai-compatible',
        label: 'Custom OpenAI',
        description: 'Custom OpenAI-compatible provider',
        protocol: 'openai',
        steps: [],
      },
    ],
    groups: [
      {
        id: 'custom',
        label: 'Custom',
        description: 'Custom providers',
        providerIds: ['custom-openai-compatible'],
      },
    ],
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.clearAllMocks();
});

async function install(
  runtimeSync: 'applied' | 'deferred' | 'failed' | undefined,
) {
  actions.installAuthProvider.mockResolvedValue({
    v: 1,
    providerId: 'custom-openai-compatible',
    providerLabel: 'Custom OpenAI',
    authType: 'openai',
    message: 'Provider saved.',
    ...(runtimeSync ? { runtimeSync: { status: runtimeSync } } : {}),
  });
  return openAndSave();
}

async function openAndSave() {
  const onMessage = vi.fn();
  const onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <I18nProvider language="en">
        <AuthMessage onMessage={onMessage} onClose={onClose} />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const click = async (text: string) => {
    const target = Array.from(container?.querySelectorAll('button') ?? []).find(
      (item) => item.textContent?.trim().startsWith(text),
    );
    if (!target) {
      throw new Error(`Button ${text} not found in ${container?.textContent}`);
    }
    await act(async () => {
      target.click();
      await Promise.resolve();
    });
  };
  await click('Custom');
  await click('Save');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onMessage, onClose };
}

describe('AuthMessage runtime provider sync', () => {
  it('closes after save and appends a warning when runtime sync failed', async () => {
    const { onMessage, onClose } = await install('failed');

    expect(onMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        'Provider saved.\n\nThe change was saved, but running sessions could not be refreshed.',
      ),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'applied', 'deferred'] as const)(
    'keeps the existing success message for runtime sync %s',
    async (status) => {
      const { onMessage, onClose } = await install(status);

      expect(onMessage).toHaveBeenCalledWith('Provider saved.');
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it('ignores an install completion after the session owner changes', async () => {
    let resolveInstall:
      | ((value: {
          v: 1;
          providerId: string;
          providerLabel: string;
          authType: string;
          message: string;
        }) => void)
      | undefined;
    actions.installAuthProvider.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const { onMessage, onClose } = await openAndSave();

    ownerState.version += 1;
    await act(async () => {
      root?.render(
        <I18nProvider language="en">
          <AuthMessage onMessage={onMessage} onClose={onClose} />
        </I18nProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveInstall?.({
        v: 1,
        providerId: 'custom-openai-compatible',
        providerLabel: 'Custom OpenAI',
        authType: 'openai',
        message: 'Provider saved.',
      });
      await Promise.resolve();
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const saveButton = Array.from(
      container?.querySelectorAll('button') ?? [],
    ).at(-1);
    expect(saveButton?.disabled).toBe(false);
  });
});
