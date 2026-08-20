/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import {
  ProviderSetupSteps,
  remapCaretAcrossResplit,
  resplitCustomModelIdsText,
} from './ProviderSetupSteps.js';
import type { ProviderSetupFlow } from './useProviderSetupFlow.js';

type UseKeypressMockOptions = { isActive: boolean };

vi.mock('../hooks/useKeypress.js');

let activeKeypressHandlers: KeypressHandler[] = [];

describe('ProviderSetupSteps', () => {
  beforeEach(() => {
    activeKeypressHandlers = [];
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, options?: UseKeypressMockOptions) => {
        if (options?.isActive) {
          activeKeypressHandlers.push(handler);
        }
      },
    );
  });

  const pressKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    if (activeKeypressHandlers.length === 0) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    const event = {
      name,
      sequence,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      ...overrides,
    };
    for (const handler of activeKeypressHandlers) {
      handler(event);
    }
  };

  const pressLatestKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    const handler = activeKeypressHandlers.at(-1);
    if (!handler) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    handler({
      name,
      sequence,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      ...overrides,
    });
  };

  const createAdvancedConfigFlow = (): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          name: 'Custom',
          authType: AuthType.USE_OPENAI,
          protocol: AuthType.USE_OPENAI,
          showAdvancedConfig: true,
        },
        step: 'advancedConfig',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds: '',
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: true,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: noop,
      submitModelIds: noop,
      moveAdvancedFocusUp: vi.fn(),
      moveAdvancedFocusDown: vi.fn(),
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  const createModelIdsFlow = ({
    modelIds = 'MiniMax-M3, MiniMax-M2.7',
    changeModelIds = vi.fn(),
    submitModelIds = vi.fn(),
  }: {
    modelIds?: string;
    changeModelIds?: ReturnType<typeof vi.fn>;
    submitModelIds?: ReturnType<typeof vi.fn>;
  } = {}): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          id: 'minimax',
          label: 'MiniMax API Key',
          description: 'Quick setup for MiniMax models',
          protocol: AuthType.USE_OPENAI,
          baseUrl: 'https://api.minimax.io/v1',
          envKey: 'MINIMAX_API_KEY',
          models: [
            {
              id: 'MiniMax-M3',
              contextWindowSize: 1000000,
              modalities: { image: true, video: true },
            },
            { id: 'MiniMax-M2.7', contextWindowSize: 204800 },
            { id: 'MiniMax-M2.5', contextWindowSize: 196608 },
          ],
          modelsEditable: true,
          modelNamePrefix: 'MiniMax',
        },
        step: 'models',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds,
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: true,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds,
      submitModelIds,
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  const createCustomModelIdsFlow = ({
    modelIds = 'model-a, model-b',
    submitModelIds = vi.fn(),
  }: {
    modelIds?: string;
    submitModelIds?: ReturnType<typeof vi.fn>;
  } = {}): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          id: 'custom-openai-compatible',
          label: 'Custom Provider',
          description: 'Manually connect a provider',
          protocol: AuthType.USE_OPENAI,
          modelsEditable: true,
          showAdvancedConfig: true,
        },
        step: 'models',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds,
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: false,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: noop,
      submitModelIds,
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  it('maps Ctrl+P/N to advanced-config focus navigation', () => {
    const flow = createAdvancedConfigFlow();

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('p', '\u0010', { ctrl: true });
    pressKey('n', '\u000E', { ctrl: true });

    expect(flow.moveAdvancedFocusUp).toHaveBeenCalledTimes(1);
    expect(flow.moveAdvancedFocusDown).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders predefined editable models with a primary free-form input and recommendations', () => {
    const flow = createModelIdsFlow();

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs directly');
    expect(frame).toContain('Recommended models');
    expect(frame).toContain(
      'Checked recommended models are applied on submit but not copied into the input.',
    );
    expect(frame).toContain('◉');
    expect(frame).toContain('○');
    expect(frame).not.toContain('›');
    expect(frame).not.toContain('[x]');
    expect(frame).not.toContain('[ ]');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).toContain('1,000,000 tokens');
    expect(frame).toContain('text/image/video');
    expect(frame).toContain('204,800 tokens, text');
    expect(frame).not.toContain('Edit raw / custom model IDs');
    expect(frame).not.toContain('Tab for custom IDs');
    expect(frame).toContain('Search');
    expect(frame).toContain(
      '↑↓/Tab to switch input, search, and recommendations',
    );
    expect(frame).not.toContain('Enter model IDs separated by commas');
    unmount();
  });

  it('recommends the discovered list and says where it came from', () => {
    // The flow hook prunes retired ids out of `modelIds` before handing the
    // step a discovered list, so the fixture starts from a pruned selection.
    const flow = createModelIdsFlow({ modelIds: 'MiniMax-M3' });
    const state = flow.state as unknown as Record<string, unknown>;
    state['recommendedModels'] = [
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
      { id: 'MiniMax-M4-new' },
    ];
    state['discoveryStatus'] = 'success';

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('from the provider');
    expect(frame).toContain('MiniMax-M4-new');
    // Built-ins the endpoint no longer serves are not offered.
    expect(frame).not.toContain('MiniMax-M2.7');
    unmount();
  });

  it('says the list is still being fetched while the lookup is in flight', () => {
    const flow = createModelIdsFlow();
    const state = flow.state as unknown as Record<string, unknown>;
    state['discoveryStatus'] = 'loading';

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    // Saying "from the provider" here would be a lie about a list that is
    // still the built-in one.
    expect(frame).toContain('fetching the provider model list…');
    expect(frame).not.toContain('from the provider');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).toContain('MiniMax-M2.7');
    unmount();
  });

  it('re-derives the model step when the recommendation list is replaced', () => {
    // The step derives its checkbox and custom-input split once, at mount.
    // Without the revision remount, an id that was checked from the previous
    // list renders nowhere after the swap — invisible and unremovable, yet
    // still submitted.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({
      modelIds: 'MiniMax-M3, discovered-only',
    });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['recommendedModels'] = [
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
      { id: 'discovered-only' },
    ];
    beforeState['discoveryStatus'] = 'success';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );
    expect(lastFrame() ?? '').toContain('discovered-only');

    // The lookup for the next pair failed, so the built-in list comes back.
    const after = createModelIdsFlow({
      modelIds: 'MiniMax-M3, discovered-only',
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
    ];
    afterState['discoveryStatus'] = 'failed';
    afterState['recommendedModelsRevision'] = 1;

    act(() => {
      swapFlow(after);
    });

    // Re-derived: the id no longer on offer moved into the custom-ids input,
    // where the user can still see and remove it.
    expect(lastFrame() ?? '').toContain('discovered-only');
    unmount();
  });

  it('keeps an in-progress search and its focus across a recommendation swap', async () => {
    // R4-6: the step used to be remounted by a `key` on the revision, which
    // also re-ran its one-shot `useState` initializers — so a lookup landing
    // while the user was mid-search (a window up to the 5s discovery timeout)
    // wiped the query and dropped focus onto the custom-ids input. The rest of
    // the search keystrokes then merged into the custom model IDs field and
    // the Enter meant for the search box installed the provider with a junk id.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({
      modelIds: 'MiniMax-M3, discovered-only',
    });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['recommendedModels'] = [
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
      { id: 'MiniMax-M2.7', contextWindowSize: 204800 },
      { id: 'discovered-only' },
    ];
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    // Focus the recommendations, then start typing a search.
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('M', 'M');
    });
    expect(lastFrame() ?? '').toContain('> M');

    // The endpoint resolves mid-typing and replaces the list.
    const after = createModelIdsFlow({
      modelIds: 'MiniMax-M3, discovered-only',
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
      { id: 'MiniMax-M2.7', contextWindowSize: 204800 },
    ];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });

    // The query survived the swap, and so did the list filtering it drives.
    expect(lastFrame() ?? '').toContain('> M');
    // The re-derive still ran: the id no longer on offer moved into the
    // custom-ids input, where the user can see and remove it.
    expect(lastFrame() ?? '').toContain('discovered-only');

    // Focus survived too — the next keystroke still extends the search rather
    // than merging into the custom model IDs field.
    await act(async () => {
      pressLatestKey('3', '3');
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('> M3');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).not.toContain('MiniMax-M2.7');
    unmount();
  });

  it('keeps a half-typed separator in the custom-ids input across a swap', async () => {
    // R5-1: the custom-ids buffer is uncontrolled, and the re-derive recomputed
    // its text from the normalized `flow.state.modelIds` — where
    // `normalizeModelIds` has already dropped the bare trailing segment. A
    // lookup resolving while the user sat between two ids therefore remounted
    // the input over `id1,` with `id1`, cursor back at offset 0, so the next
    // character glued onto the previous id and Enter installed one
    // concatenated, nonexistent model id where the user meant two.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow();
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    // The custom-ids input takes the initial focus, so typing starts there.
    for (const char of ['i', 'd', '1', ',']) {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    expect(lastFrame() ?? '').toContain('id1,');

    // The endpoint resolves in that gap and bumps the revision. The two
    // built-ins are checked recommendations, so they are in `modelIds` too.
    const submitModelIds = vi.fn();
    const changeModelIds = vi.fn();
    const after = createModelIdsFlow({ submitModelIds });
    (after as unknown as Record<string, unknown>)['changeModelIds'] =
      changeModelIds;
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['modelIds'] = 'id1, MiniMax-M3, MiniMax-M2.7';
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });

    // The separator carries no id, so no re-derive is entitled to drop it.
    expect(lastFrame() ?? '').toContain('id1,');

    // The next id must start its own segment, not extend the previous one.
    await act(async () => {
      pressLatestKey('q', 'q');
    });
    await act(async () => {
      pressLatestKey('return');
    });

    expect(changeModelIds.mock.calls.at(-1)?.[0]).toBe(
      'id1, q, MiniMax-M3, MiniMax-M2.7',
    );
    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['id1', 'q', 'MiniMax-M3', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('keeps typing at the caret when a swap moves an id out of the input', async () => {
    // R6-1: the re-derive remounts the custom-ids input to show the new split,
    // and a remount reseeds `useTextBuffer` at offset 0 — while the re-derive
    // deliberately leaves focus on that input. A lookup resolving mid-id
    // therefore sent the rest of the user's keystrokes to the FRONT of the
    // buffer, and Enter installed the garble. The ids a swap removes are the
    // finished ones (they move to their checkbox); what is left is the segment
    // still being typed, at the end.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    // The custom-ids input takes the initial focus. The user is partway
    // through the second id when the endpoint answers.
    for (const char of 'new-model-x,sec') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    expect(lastFrame() ?? '').toContain('new-model-x,sec');

    // The endpoint serves `new-model-x`, so it moves out to its checkbox and
    // the buffer becomes just the half-typed `sec`.
    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'new-model-x',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [
      { id: 'new-model-x' },
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
    ];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });

    // The rest of the id must append, not insert at offset 0.
    for (const char of 'ond') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['second', 'new-model-x'],
    });
    unmount();
  });

  it('keeps the caret mid-buffer when a swap rewrites the custom-ids text', async () => {
    // R7-1: R6-1 reseeded the caret at the END of the re-derived text, on the
    // premise that what is left is the segment still being typed. That premise
    // is false the moment the user arrows back to fix an earlier segment: the
    // remount then dropped their correction at the end of the buffer and Enter
    // installed the garbled id — the same broken-install class R5-1/R6-1 exist
    // to close, left open for the mid-buffer case.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    // The custom-ids input takes the initial focus. The user types both ids,
    // then arrows back into the first one to insert the `l` they dropped.
    const typed = 'my-depoy, qwen3-coder-plus';
    for (const char of typed) {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    expect(lastFrame() ?? '').toContain(typed);

    // Land between `my-dep` and `oy`.
    const caretTarget = 'my-dep'.length;
    for (let i = typed.length; i > caretTarget; i--) {
      await act(async () => {
        pressLatestKey('left');
      });
    }

    // The endpoint answers mid-correction and serves `qwen3-coder-plus`, so it
    // moves out to its checkbox and the buffer is re-derived to `my-depoy`.
    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'my-depoy, qwen3-coder-plus',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [
      { id: 'qwen3-coder-plus' },
      { id: 'MiniMax-M3', contextWindowSize: 1000000 },
    ];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });
    expect(lastFrame() ?? '').toContain('my-depoy');

    // The correction must land at the caret the user left it at, not at the
    // end of the re-derived text.
    await act(async () => {
      pressLatestKey('l', 'l');
    });
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['my-deploy', 'qwen3-coder-plus'],
    });
    unmount();
  });

  it('resumes at the end of the buffer when the step is re-entered mid-id', async () => {
    // R8-1: `ModelIdsStep` mounts fresh whenever the user Escs to an earlier
    // step and comes back — a new caret ref, and a `TextInput` that reports
    // its seeded 0 before the re-derive runs. The old clamp trusted that 0,
    // so a re-derive landing on the fresh mount sent the rest of a half-typed
    // id to the FRONT of the buffer and Enter installed `ondsec` where
    // `second` was meant. This renders the re-entry directly: a fresh mount
    // whose buffer already holds the in-progress id.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    // Re-entered with `sec` already typed and `X-discovered` checked off the
    // first pair's list.
    const before = createModelIdsFlow({ modelIds: 'sec, X-discovered' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['recommendedModels'] = [{ id: 'X-discovered' }];
    beforeState['discoveryStatus'] = 'success';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );
    expect(lastFrame() ?? '').toContain('sec');

    // The second key/region's list does not offer `X-discovered`, so it falls
    // back into the buffer and the input remounts as `sec, X-discovered`.
    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'sec, X-discovered',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'MiniMax-M2.7' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });
    expect(lastFrame() ?? '').toContain('sec, X-discovered');

    // Finishing the id must extend `sec`, not prefix it.
    for (const char of 'ond') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['second', 'X-discovered'],
    });
    unmount();
  });

  it('keeps the caret in its own segment when a swap removes text before it', async () => {
    // R9-1: R7-1 carried the live caret across the remount, but reinstated it
    // as a raw offset. `resplitCustomModelIdsText` also removes segments from
    // BEFORE the caret — here a built-in the endpoint turns out not to serve —
    // and the flat clamp then strands the caret in a different segment than
    // the one being edited: `min(17, 8) = 8`, the end of the buffer, so the
    // correction lands after `y` and Enter installs `my-depoyl`.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    const typed = 'MiniMax-M3,my-depoy';
    for (const char of typed) {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    expect(lastFrame() ?? '').toContain(typed);

    // Arrow back between `my-dep` and `oy` — offset 17, inside the SECOND
    // segment.
    for (let i = typed.length; i > 'MiniMax-M3,my-dep'.length; i--) {
      await act(async () => {
        pressLatestKey('left');
      });
    }

    // Discovery answers: the endpoint does not serve `MiniMax-M3`, so the
    // prune drops it from both the ids and the buffer, taking 11 code points
    // from in FRONT of the caret.
    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'my-depoy',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'qwen3-coder-plus' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });
    expect(lastFrame() ?? '').toContain('my-depoy');

    await act(async () => {
      pressLatestKey('l', 'l');
    });
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['my-deploy'],
    });
    unmount();
  });

  it('keeps typing an exact served model id as the active custom segment', async () => {
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;
    const { unmount } = renderWithProviders(<FlowHarness first={before} />);

    for (const char of 'qwen4-flash') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }

    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'qwen4-flash',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'qwen4-flash' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;
    await act(async () => {
      swapFlow(after);
    });

    for (const char of '-latest') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['qwen4-flash-latest'],
    });
    unmount();
  });

  it('keeps typing a served built-in even when composition dedupes it', async () => {
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow();
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;
    const { unmount } = renderWithProviders(<FlowHarness first={before} />);

    for (const char of 'MiniMax-M3') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }

    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({ submitModelIds });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;
    await act(async () => {
      swapFlow(after);
    });

    for (const char of '-latest') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['MiniMax-M3-latest', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('keeps a leading separator and its caret across a recommendation swap', async () => {
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;
    const { unmount } = renderWithProviders(<FlowHarness first={before} />);

    for (const char of ',foo') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    for (let offset = 0; offset < 4; offset += 1) {
      await act(async () => {
        pressLatestKey('left');
      });
    }

    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'foo, MiniMax-M3',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'foo' }, { id: 'MiniMax-M3' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;
    await act(async () => {
      swapFlow(after);
    });

    await act(async () => {
      pressLatestKey('x', 'x');
    });
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['x', 'foo', 'MiniMax-M3'],
    });
    unmount();
  });

  it('drops a typed built-in id the new list no longer offers', async () => {
    // R6-2: `applyDiscoveredModels` prunes a built-in id the endpoint does not
    // serve "whether it was checked by default or typed" — but a typed one
    // also sits in this buffer, which the re-derive kept verbatim, and the
    // submit path never prunes again. Enter then reinstalled the stale id into
    // the provider config and every later call against that endpoint failed
    // with model-not-found. Ids outside the built-in list are a different
    // case: they may be legitimately unlisted, so they must survive.
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;

    const { lastFrame, unmount } = renderWithProviders(
      <FlowHarness first={before} />,
    );

    // Typed while the lookup is still in flight: one built-in id, one private
    // deployment the built-in list has never heard of.
    for (const char of 'MiniMax-M3,my-deploy') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    expect(lastFrame() ?? '').toContain('MiniMax-M3,my-deploy');

    // Discovery answers without `MiniMax-M3`: the flow pruned it out of
    // `modelIds`, and the buffer must not hold it back.
    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'MiniMax-M2.7',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'MiniMax-M2.7' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;

    await act(async () => {
      swapFlow(after);
    });

    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['my-deploy', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('drops a pruned built-in after the caret moves back into its segment', async () => {
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;
    const { unmount } = renderWithProviders(<FlowHarness first={before} />);

    for (const char of 'MiniMax-M3,priv') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    for (let offset = 0; offset < 12; offset += 1) {
      await act(async () => {
        pressLatestKey('left');
      });
    }

    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({ modelIds: 'priv', submitModelIds });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'MiniMax-M2.7' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;
    await act(async () => {
      swapFlow(after);
    });

    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({ modelIds: ['priv'] });
    unmount();
  });

  it('reports the post-edit caret when a separator ends an active id', async () => {
    const changeModelIds = vi.fn();
    const flow = createModelIdsFlow({ modelIds: '', changeModelIds });

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    for (const char of 'MiniMax-M3,') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }

    expect(changeModelIds).toHaveBeenLastCalledWith(
      'MiniMax-M3',
      expect.objectContaining({ activeCustomModelId: undefined }),
    );
    unmount();
  });

  it('does not protect a custom-input token after focus leaves the input', async () => {
    let swapFlow!: (next: ProviderSetupFlow) => void;
    function FlowHarness({ first }: { first: ProviderSetupFlow }) {
      const [flow, setFlow] = useState(first);
      swapFlow = setFlow;
      return <ProviderSetupSteps flow={flow} />;
    }

    const before = createModelIdsFlow({ modelIds: '' });
    const beforeState = before.state as unknown as Record<string, unknown>;
    beforeState['discoveryStatus'] = 'loading';
    beforeState['recommendedModelsRevision'] = 0;
    const { unmount } = renderWithProviders(<FlowHarness first={before} />);

    for (const char of 'MiniMax-M3') {
      await act(async () => {
        pressLatestKey(char, char);
      });
    }
    await act(async () => {
      pressLatestKey('down');
    });

    const submitModelIds = vi.fn();
    const after = createModelIdsFlow({
      modelIds: 'MiniMax-M2.7',
      submitModelIds,
    });
    const afterState = after.state as unknown as Record<string, unknown>;
    afterState['recommendedModels'] = [{ id: 'MiniMax-M2.7' }];
    afterState['discoveryStatus'] = 'success';
    afterState['recommendedModelsRevision'] = 1;
    await act(async () => {
      swapFlow(after);
    });
    await act(async () => {
      pressLatestKey('return');
    });

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['MiniMax-M2.7'],
    });
    unmount();
  });

  it('notes a failed lookup without hiding the built-in recommendations', () => {
    const flow = createModelIdsFlow();
    const state = flow.state as unknown as Record<string, unknown>;
    state['discoveryStatus'] = 'failed';

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('provider list unavailable, showing built-ins');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).toContain('MiniMax-M2.7');
    unmount();
  });

  it('filters recommended models when typing search while recommendations are focused', async () => {
    const flow = createModelIdsFlow();

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('M', 'M');
    });
    await act(async () => {
      pressLatestKey('3', '3');
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('> M3');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).not.toContain('MiniMax-M2.7');
    expect(frame).not.toContain('MiniMax-M2.5');
    unmount();
  });

  it('keeps recommended selections out of the free-form model input', () => {
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3, MiniMax-M2.7',
    });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    const inputLine = frame
      .split('\n')
      .find((line) => line.includes('custom-model'));
    expect(inputLine).toContain('custom-model');
    expect(inputLine).not.toContain('MiniMax-M3');
    expect(inputLine).not.toContain('MiniMax-M2.7');
    expect(frame).toMatch(/◉\uFE0E\s+MiniMax-M3/);
    expect(frame).toMatch(/◉\uFE0E\s+MiniMax-M2\.7/);
    unmount();
  });

  it('deduplicates typed and recommended model IDs on submit', () => {
    const submitModelIds = vi.fn();
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3, MiniMax-M3, MiniMax-M2.7',
      submitModelIds,
    });

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('return', '\r');

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['custom-model', 'MiniMax-M3', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('preserves comma-separated model IDs for custom providers', () => {
    const submitModelIds = vi.fn();
    const flow = createCustomModelIdsFlow({
      modelIds: 'model-a, model-b',
      submitModelIds,
    });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs separated by commas');
    expect(frame).toContain('model-a, model-b');

    pressLatestKey('return', '\r');

    expect(submitModelIds).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe('resplitCustomModelIdsText', () => {
  const BUILT_INS = new Set(['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']);

  it('empties a buffer whose only ids all moved out from in front of a trailing separator', () => {
    // D7-7/D10-1: the user typed one id and the separator for the next when
    // discovery answered with that id on it, so it moved to its checkbox and
    // nothing is left for the separator to separate. Without the empty-body
    // branch the trailing segment is still re-attached, and the step shows a
    // lone `,` sitting in an otherwise empty input — an edit the user never
    // made, on the field they are about to type the next id into.
    expect(
      resplitCustomModelIdsText(
        'my-deploy,',
        ['my-deploy'],
        new Set(['my-deploy']),
        BUILT_INS,
      ),
    ).toBe('');
  });

  it('keeps the trailing separator while any id still precedes it', () => {
    // The counterpart: the branch above must not swallow a separator the user
    // is still typing behind, which is what R5-1 restored in the first place.
    expect(
      resplitCustomModelIdsText(
        'kept,my-deploy,',
        ['my-deploy'],
        new Set(['my-deploy']),
        BUILT_INS,
      ),
    ).toBe('kept,');
  });

  it('keeps the empty segment that owns the live caret', () => {
    expect(
      resplitCustomModelIdsText(
        ',foo',
        ['foo'],
        new Set(['foo']),
        BUILT_INS,
        0,
      ),
    ).toBe(',');
    expect(remapCaretAcrossResplit(',foo', ',', 0)).toBe(0);
  });

  it('keeps a middle empty segment that owns the live caret', () => {
    expect(
      resplitCustomModelIdsText(
        'foo,,bar',
        ['foo', 'bar'],
        new Set(['foo', 'bar']),
        BUILT_INS,
        4,
      ),
    ).toBe(',');
    expect(remapCaretAcrossResplit('foo,,bar', ',', 4)).toBe(0);
  });

  it('does not re-add an unoffered selected built-in from flow state', () => {
    expect(
      resplitCustomModelIdsText(
        'foo,MiniMax-M3',
        ['foo', 'MiniMax-M3', 'MiniMax-M2.7'],
        new Set(['MiniMax-M2.7']),
        BUILT_INS,
        1,
      ),
    ).toBe('foo');
  });

  it('drops an active built-in that discovery removed from flow state', () => {
    expect(
      resplitCustomModelIdsText(
        'MiniMax-M3,priv',
        ['priv'],
        new Set(),
        BUILT_INS,
        2,
      ),
    ).toBe('priv');
  });
});

describe('remapCaretAcrossResplit', () => {
  // The step tests above only see this three keystrokes later, as a garbled
  // model id. These pin the mapping itself, including the arms no realistic
  // step scenario reaches twice.
  it('reinstates the offset inside the segment the caret was in', () => {
    // `MiniMax-M3,` (11) is removed from in front of the caret, so a flat
    // clamp would give `min(17, 8) = 8` — the end — instead of 6.
    expect(remapCaretAcrossResplit('MiniMax-M3,my-depoy', 'my-depoy', 17)).toBe(
      6,
    );
  });

  it('follows a segment that moved further back in the buffer', () => {
    expect(remapCaretAcrossResplit('a,my-depoy', 'kept-a, x,my-depoy', 8)).toBe(
      16,
    );
  });

  it('follows the same occurrence when duplicate segments survive', () => {
    expect(
      remapCaretAcrossResplit('priv,priv,MiniMax-M3', 'priv,priv', 7),
    ).toBe(7);
    expect(
      remapCaretAcrossResplit('MiniMax-M3,priv,priv', 'priv,priv', 21),
    ).toBe(9);
  });

  it('falls in at the end of the nearest surviving segment ahead of it', () => {
    // The caret's own segment moved out to a checkbox. `keep` is the closest
    // context that still exists, so the caret lands after it rather than
    // somewhere inside an id the user was not editing.
    expect(remapCaretAcrossResplit('keep,gone', 'keep', 7)).toBe(4);
  });

  it('goes to the end when nothing in front of the caret survived', () => {
    expect(remapCaretAcrossResplit('gone,also-gone', 'picked-up', 2)).toBe(9);
  });

  it('puts a caret in an empty trailing segment at the end of the new text', () => {
    // R6-1: the user typed the separator and is about to type the next id.
    // The re-derive appends what it reclaimed in front of that separator, so
    // the position they are typing at is the end.
    expect(remapCaretAcrossResplit('a,', 'a, reclaimed,', 2)).toBe(13);
  });

  it('counts in code points, not UTF-16 units', () => {
    // `🙂` is one code point and two UTF-16 units; an offset measured in units
    // would land inside the emoji.
    expect(remapCaretAcrossResplit('🙂🙂,tail', 'tail', 4)).toBe(1);
  });

  it('clamps a caret past the end of the old text', () => {
    expect(remapCaretAcrossResplit('abc', 'abc', 99)).toBe(3);
  });
});
