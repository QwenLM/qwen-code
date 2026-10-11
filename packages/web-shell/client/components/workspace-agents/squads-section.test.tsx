// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { SquadsSection } from './squads-section';
import type { SquadInput } from './threads-api';

let root: Root;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it.each(['create', 'edit'] as const)(
  'retains the %s draft while saving and after failure, then closes on success',
  async (mode) => {
    let finish!: (success: boolean) => void;
    const save = vi
      .fn<(input: SquadInput) => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(true);
    function Harness() {
      const [creating, setCreating] = useState(mode === 'create');
      return (
        <I18nProvider language="en">
          <SquadsSection
            squads={
              mode === 'edit'
                ? [
                    {
                      id: 'squad-1',
                      name: 'reviewers',
                      leaderAgentId: 'agent-1',
                      leaderName: 'reviewer',
                      members: [],
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  ]
                : []
            }
            agents={[
              {
                id: 'agent-1',
                name: 'reviewer',
                enabled: true,
                status: 'idle',
                waiting: 0,
              },
            ]}
            creating={creating}
            onCreatingChange={setCreating}
            onCreate={save}
            onUpdate={(_id, input) => save(input)}
            onRetire={() => {}}
          />
        </I18nProvider>
      );
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
    if (mode === 'edit') {
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
          );
      });
      await act(async () => {
        document.querySelector<HTMLElement>('[role="menuitem"]')!.click();
      });
    }
    const form = container.querySelector<HTMLFormElement>('form')!;
    const name = form.querySelector<HTMLInputElement>('input[name="name"]')!;
    const description = form.querySelector<HTMLInputElement>(
      'input[name="description"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(name, 'draft-squad');
      name.dispatchEvent(new Event('input', { bubbles: true }));
      const leader = form.querySelector<HTMLSelectElement>('select')!;
      leader.value = 'agent-1';
      leader.dispatchEvent(new Event('change', { bubbles: true }));
      description.value = 'Keep this description';
    });
    await act(async () =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'draft-squad',
        description: 'Keep this description',
        leaderAgentId: 'agent-1',
      }),
    );
    expect(container.querySelector('form')).toBe(form);
    await act(async () => finish(false));
    expect(container.querySelector('form')).toBe(form);
    expect(name.value).toBe('draft-squad');
    expect(description.value).toBe('Keep this description');
    await act(async () =>
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(container.querySelector('form')).toBeNull();
  },
);
