// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedSessionSkills,
} from './managed-agent-provider';
import { useManagedSkills } from './use-managed-skills';

let root: Root;
let provider: ManagedAgentProvider;
let sessionId: string | undefined;
let current: ReturnType<typeof useManagedSkills>;
const catalog = {
  skills: [{ name: 'review', description: 'Published review.' }],
};

function Probe() {
  current = useManagedSkills(provider, 'client', sessionId);
  return null;
}
const render = () => act(async () => root.render(<Probe />));

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  sessionId = 'session-a';
  provider = {
    storageKey: 'tenant:actor',
    skills: { list: vi.fn().mockResolvedValue(catalog) },
  } as unknown as ManagedAgentProvider;
});
afterEach(async () => {
  await act(async () => root.unmount());
});

it('lazily loads and caches a Session catalog including an empty catalog', async () => {
  await render();
  expect(provider.skills!.list).not.toHaveBeenCalled();
  await act(async () => current.onOpenChange(true));
  expect(current.skills).toEqual(catalog.skills);
  expect(current.loaded).toBe(true);
  await act(async () => current.onOpenChange(false));
  await act(async () => current.onOpenChange(true));
  expect(provider.skills!.list).toHaveBeenCalledOnce();
  vi.mocked(provider.skills!.list).mockResolvedValue({ skills: [] });
  sessionId = 'session-b';
  await render();
  expect(current.skills).toEqual([]);
  expect(current.loaded).toBe(true);
});

it('shows failure and retries when reopened', async () => {
  vi.mocked(provider.skills!.list).mockRejectedValueOnce(new Error('offline'));
  await render();
  await act(async () => current.onOpenChange(true));
  expect(current.error).toBe(true);
  expect(current.loading).toBe(false);
  await act(async () => current.onOpenChange(false));
  await act(async () => current.onOpenChange(true));
  expect(current.error).toBe(false);
  expect(current.skills).toEqual(catalog.skills);
});

it('aborts old requests and hides late results across Session and provider changes', async () => {
  let release!: (value: ManagedSessionSkills) => void;
  vi.mocked(provider.skills!.list).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await act(async () => current.onOpenChange(true));
  expect(current.loading).toBe(true);
  const signal = vi.mocked(provider.skills!.list).mock.calls[0][1].signal!;
  sessionId = 'session-b';
  await render();
  expect(signal.aborted).toBe(true);
  await act(async () =>
    release({ skills: [{ name: 'old', description: 'Old.' }] }),
  );
  expect(current.skills).toEqual(catalog.skills);
  provider = { ...provider, skills: undefined };
  await render();
  expect(current.supported).toBe(false);
  expect(current.skills).toEqual([]);
  sessionId = undefined;
  await render();
  expect(current.supported).toBe(false);
});
