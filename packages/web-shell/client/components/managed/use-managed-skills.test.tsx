// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  ManagedAgentProvider,
  ManagedSessionSkills,
} from './managed-agent-provider';
import { useManagedSkills } from './use-managed-skills';
import type { ManagedCreationSkillsSource } from './managed-creation-skills';

let root: Root;
let provider: ManagedAgentProvider;
let sessionId: string | undefined;
let creationSkills: ManagedCreationSkillsSource | undefined;
let current: ReturnType<typeof useManagedSkills>;
const catalog = {
  skills: [{ name: 'review', description: 'Published review.' }],
};

function Probe() {
  current = useManagedSkills(provider, 'client', sessionId, creationSkills);
  return null;
}
const render = () => act(async () => root.render(<Probe />));

beforeEach(() => {
  root = createRoot(document.createElement('div'));
  sessionId = 'session-a';
  creationSkills = undefined;
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

function creationSource(): ManagedCreationSkillsSource {
  return {
    workspaceCwd: '/selected-source',
    list: vi.fn().mockResolvedValue(catalog.skills),
    load: vi.fn(),
  };
}

it('lazily lists creation Skills and refreshes enabled entries on reopening', async () => {
  sessionId = undefined;
  creationSkills = creationSource();
  await render();
  const onOpenChange = current.onOpenChange;
  expect(current.supported).toBe(true);
  expect(creationSkills.list).not.toHaveBeenCalled();
  await act(async () => current.onOpenChange(true));
  expect(current.skills).toEqual(catalog.skills);
  expect(current.loaded).toBe(true);
  expect(current.onOpenChange).toBe(onOpenChange);
  await act(async () => current.onOpenChange(false));
  vi.mocked(creationSkills.list).mockResolvedValue([]);
  await act(async () => current.onOpenChange(true));
  expect(current.skills).toEqual([]);
  expect(current.loaded).toBe(true);
  expect(creationSkills.list).toHaveBeenCalledTimes(2);
  expect(creationSkills.load).not.toHaveBeenCalled();
  expect(provider.skills!.list).not.toHaveBeenCalled();
});

it('retries failed creation metadata on reopening without loading bodies', async () => {
  sessionId = undefined;
  creationSkills = creationSource();
  vi.mocked(creationSkills.list).mockRejectedValueOnce(new Error('offline'));
  await render();
  await act(async () => current.onOpenChange(true));
  expect(current.error).toBe(true);
  expect(current.loading).toBe(false);
  await act(async () => current.onOpenChange(false));
  await act(async () => current.onOpenChange(true));
  expect(current.error).toBe(false);
  expect(current.skills).toEqual(catalog.skills);
  expect(creationSkills.load).not.toHaveBeenCalled();
});

it('aborts and hides creation results when the selected source changes or disappears', async () => {
  sessionId = undefined;
  creationSkills = creationSource();
  let release!: (value: ManagedSessionSkills['skills']) => void;
  vi.mocked(creationSkills.list).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await render();
  await act(async () => current.onOpenChange(true));
  expect(current.loading).toBe(true);
  const signal = vi.mocked(creationSkills.list).mock.calls[0][0];
  creationSkills = { ...creationSource(), workspaceCwd: '/another-source' };
  await render();
  expect(signal.aborted).toBe(true);
  await act(async () => release([{ name: 'old', description: 'Old.' }]));
  expect(current.skills).toEqual(catalog.skills);
  creationSkills = undefined;
  await render();
  expect(current.supported).toBe(false);
  expect(current.skills).toEqual([]);
});

it('uses only the pinned Session catalog once a Session exists', async () => {
  creationSkills = creationSource();
  await render();
  await act(async () => current.onOpenChange(true));
  expect(provider.skills!.list).toHaveBeenCalledWith(
    'session-a',
    expect.objectContaining({ clientId: 'client' }),
  );
  expect(creationSkills.list).not.toHaveBeenCalled();
  provider = { ...provider, skills: undefined };
  await render();
  expect(current.supported).toBe(false);
  expect(current.skills).toEqual([]);
  expect(creationSkills.list).not.toHaveBeenCalled();
});
