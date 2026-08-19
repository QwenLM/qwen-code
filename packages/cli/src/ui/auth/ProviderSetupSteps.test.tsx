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
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
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
    submitModelIds = vi.fn(),
  }: {
    modelIds?: string;
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
