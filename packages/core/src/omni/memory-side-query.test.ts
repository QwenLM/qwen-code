/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Content } from '@google/genai';
import type { Config } from '../config/config.js';
import {
  DEFAULT_OMNI_MEMORY_CONFIG,
  MediaMemoryService,
  MediaResourceRegistry,
} from '../services/media-memory/index.js';
import {
  formatResourceHandleText,
  formatResourcePathText,
} from './disclosure.js';
import {
  extractRequestResourceIds,
  formatOmniMemorySideQueryReminder,
  runOmniMemorySideQuery,
} from './memory-side-query.js';

vi.mock('../utils/sideQuery.js', () => ({ runSideQuery: vi.fn() }));
import { runSideQuery } from '../utils/sideQuery.js';

const runSideQueryMock = vi.mocked(runSideQuery);

/** The slice of the selector's `runSideQuery` options these tests inspect —
 * everything the production caller is responsible for composing. */
interface SelectorOptions {
  contents: Content[];
  abortSignal: AbortSignal;
  promptId?: string;
  validate?: (response: { entryIds: unknown }) => string | null;
}

/** What the harness puts in front of the selector model. */
interface SelectorPayload {
  request: string;
  candidates: Array<{ entryId: string }>;
}

function parseSelectorPayload(options: SelectorOptions): SelectorPayload {
  return JSON.parse(
    (options.contents[0]!.parts![0] as { text: string }).text,
  ) as SelectorPayload;
}

/** Stand in for `runSideQuery` the way production behaves: the parsed model
 * response is run through the caller's `validate` closure and its message
 * is THROWN (sideQuery.ts). Mocks that only read `options.contents` and
 * return a selection never touch `validate`, so a broken membership/budget
 * check would go unnoticed even though it rejects every real selection. */
function mockSelector(
  respond: (payload: SelectorPayload) => { entryIds: unknown[] },
): void {
  runSideQueryMock.mockImplementation((async (
    _config: unknown,
    options: SelectorOptions,
  ) => {
    const response = respond(parseSelectorPayload(options));
    const rejection = options.validate?.(response);
    if (rejection) throw new Error(rejection);
    return response;
  }) as never);
}

describe('omni memory sideQuery selector', () => {
  let tmpDir: string;
  let registry: MediaResourceRegistry;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-sidequery-'));
    registry = new MediaResourceRegistry();
    runSideQueryMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  type SideQuerySettings =
    (typeof DEFAULT_OMNI_MEMORY_CONFIG)['recall']['sideQuery'];

  function memoryConfig(
    mode: 'active' | 'sideQuery',
    sideQuery?: Partial<SideQuerySettings>,
  ) {
    return {
      ...DEFAULT_OMNI_MEMORY_CONFIG,
      recall: {
        ...DEFAULT_OMNI_MEMORY_CONFIG.recall,
        mode,
        sideQuery: {
          ...DEFAULT_OMNI_MEMORY_CONFIG.recall.sideQuery,
          ...sideQuery,
        },
      },
    };
  }

  function sideQueryConfig(
    mode: 'active' | 'sideQuery' = 'sideQuery',
    sideQuery?: Partial<SideQuerySettings>,
  ): Config {
    return {
      getOmniMemoryConfig: () => memoryConfig(mode, sideQuery),
      getOmniMediaResourceRegistry: () => registry,
      storage: { getQwenDir: () => tmpDir },
      getToolRegistry: () => ({ getTool: () => undefined }),
      getOmniPolicyToolsSettings: () => undefined,
    } as unknown as Config;
  }

  /** Record one image into the store under `fileRef` and bind its session
   * handle. `sha256` is parameterized so callers can mint a distinct file
   * VERSION at the same path. */
  async function recordAndBindFileRef(
    fileRef: string,
    sha256: string = 'a'.repeat(64),
  ): Promise<string> {
    const memory = new MediaMemoryService(path.join(tmpDir, 'omni'));
    const binding = await memory.recordFileRecognized({
      fileRef,
      sha256,
      mediaType: 'image',
      metadata: { width: 32, height: 32 },
      sizeBytes: 1234,
      mimeType: 'image/png',
      origin: 'user',
      source: { protocol: 'local', locator: path.basename(fileRef) },
      recognition: {
        ingestionConfigHash: '',
        detectorVersion: 'omni-sniff-ffprobe/1',
        probeStatus: 'complete',
      },
    });
    return registry.bind({
      ...binding!,
      fileRef,
      mediaType: 'image',
    }).resourceId;
  }

  /** Record one image into the store and bind its session handle. */
  function recordAndBind(): Promise<string> {
    return recordAndBindFileRef(path.join(tmpDir, 'pic.png'));
  }

  describe('extractRequestResourceIds', () => {
    it('collects issued handles from annotation lines, deduplicated', async () => {
      const resourceId = await recordAndBind();
      const parts = [
        'plain user text',
        { text: formatResourceHandleText('pic.png', resourceId) },
        {
          text:
            'context\n' +
            formatResourceHandleText('pic.png', resourceId) +
            '\nmore',
        },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });

    it('ignores handles this session never issued', () => {
      const parts = [
        { text: formatResourceHandleText('ghost.png', 'media-7-abcdef01') },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([]);
    });

    it('recovers the handle from a path-form annotation via resolveByFileRef', async () => {
      // Model-visible local media is annotated with its absolute path, not
      // the opaque handle; passive recall must still map that path back to
      // the session handle so recall keys on both annotation forms.
      const resourceId = await recordAndBind();
      const parts = [
        'plain user text',
        { text: formatResourcePathText(path.join(tmpDir, 'pic.png')) },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });

    it('ignores a path-form annotation for a file this session never bound', () => {
      const parts = [
        { text: formatResourcePathText(path.join(tmpDir, 'never-seen.png')) },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([]);
    });

    it('resolves a path-form annotation whose filename ends in whitespace', async () => {
      // A trailing space is a legal POSIX filename char; it rides in the
      // fileRef and the annotation. Parsing must NOT trim it away, or the
      // exact-equality resolveByFileRef misses and the file's memory is
      // silently dropped from passive recall.
      const fileRef = path.join(tmpDir, 'pic.png ');
      const resourceId = await recordAndBindFileRef(fileRef);
      const parts = [{ text: formatResourcePathText(fileRef) }];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });

    it('resolves a path-form annotation whose filename ends in a handle-shaped suffix', async () => {
      // The escaped separator must not be misread as a handle boundary; the
      // whole path resolves back to its own binding.
      const fileRef = path.join(tmpDir, 'clip：media-3-9f2cabcd');
      const resourceId = await recordAndBindFileRef(fileRef);
      const parts = [{ text: formatResourcePathText(fileRef) }];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });

    it('resolves a path form embedded in a line with leading whitespace', async () => {
      // Annotations can be flattened into a larger part with indentation;
      // leading whitespace is line formatting, not part of the path.
      const resourceId = await recordAndBind();
      const parts = [
        {
          text: `context\n   ${formatResourcePathText(
            path.join(tmpDir, 'pic.png'),
          )}\nmore`,
        },
      ];
      expect(extractRequestResourceIds(sideQueryConfig(), parts)).toEqual([
        resourceId,
      ]);
    });
  });

  describe('runOmniMemorySideQuery', () => {
    it('is a no-op in active mode (D10 mutual exclusion)', async () => {
      const resourceId = await recordAndBind();
      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig('active'),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });
      expect(outcome).toBeNull();
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });

    it('is a no-op when the request carries no handles', async () => {
      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: ['just text'],
      });
      expect(outcome).toBeNull();
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });

    it('materializes the selector picks and formats the reminder', async () => {
      const resourceId = await recordAndBind();
      // Capture, assert AFTER: production wraps the selector call in
      // try/catch and turns any throw into `selector_failed` degradation, so
      // a failed expect() INSIDE the mock would surface as a null result
      // instead of naming what leaked.
      let seenPayload: SelectorPayload | undefined;
      mockSelector((payload) => {
        seenPayload = payload;
        return { entryIds: [payload.candidates[0]!.entryId] };
      });

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          'what size is this image?',
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(seenPayload?.request).toContain('what size is this image');
      // Selector-visible manifest: summaries only, no paths.
      expect(JSON.stringify(seenPayload?.candidates)).not.toContain(tmpDir);
      expect(outcome?.result).not.toBeNull();
      expect(outcome!.result!.entries).toHaveLength(1);
      expect(outcome!.result!.entries[0]!.kind).toBe('metadata');
      const reminder = formatOmniMemorySideQueryReminder(outcome!.result!);
      expect(reminder).toContain('【媒体记忆】');
      expect(reminder).toContain(outcome!.result!.entries[0]!.entryId);
      expect(reminder).not.toContain(tmpDir);
    });

    it('shows the selector the question even when IDE context is merged in', async () => {
      const resourceId = await recordAndBind();
      let seenRequest = '';
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: { contents: Content[] },
      ) => {
        const payload = JSON.parse(
          (options.contents[0]!.parts![0] as { text: string }).text,
        );
        seenRequest = payload.request;
        return { entryIds: [] };
      }) as never);

      // Exactly how client.ts builds the parts in IDE mode: wrapIdeContext
      // output is PREPENDED INTO the user's own text part, before the
      // passive-recall pass runs — so the question lives in a part that
      // STARTS with <system-reminder>. Dropping such parts wholesale would
      // make the selector pick relevance-blind.
      await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          {
            text:
              '<system-reminder>\nActive file: /x/y.ts\n</system-reminder>' +
              'what size is this image?',
          },
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(seenRequest).toContain('what size is this image?');
      // The reminder itself is stripped, not forwarded.
      expect(seenRequest).not.toContain('system-reminder');
      expect(seenRequest).not.toContain('/x/y.ts');
    });

    it('degrades to an empty recall with a reason when the selector fails', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockRejectedValue(new Error('boom'));

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({
        result: null,
        reason: expect.stringContaining('selector_failed'),
      });
    });

    it('rejects a selection the candidate manifest does not authorize', async () => {
      // The `validate` closure is the only thing standing between the
      // selector and an arbitrary entryId: a wrong verdict either lets a
      // forged/cross-root id through to materialization, or (inverted)
      // rejects every legitimate selection — and with the default
      // `maxAttempts: 1` that turns every passive recall into
      // `selector_failed`, silently killing the whole feature.
      const resourceId = await recordAndBind();
      let validate: SelectorOptions['validate'];
      let manifestEntryId = '';
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: SelectorOptions,
      ) => {
        validate = options.validate;
        manifestEntryId = parseSelectorPayload(options).candidates[0]!.entryId;
        return { entryIds: [] };
      }) as never);

      await runOmniMemorySideQuery({
        config: sideQueryConfig('sideQuery', { maxSelectedEntries: 1 }),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(validate).toBeDefined();
      expect(validate!({ entryIds: [manifestEntryId] })).toBeNull();
      expect(validate!({ entryIds: ['media-entry-forged'] })).toContain(
        'not in the candidate manifest',
      );
      // Two copies of a legal id are still two picks: the budget cap is
      // judged before membership, so the manifest needs only one entry.
      expect(
        validate!({ entryIds: [manifestEntryId, manifestEntryId] }),
      ).toContain('at most 1 entryIds');
      expect(validate!({ entryIds: 'everything' })).toContain(
        'must be an array',
      );
    });

    it('degrades when the selector names an entryId outside the manifest', async () => {
      const resourceId = await recordAndBind();
      mockSelector(() => ({ entryIds: ['media-entry-forged'] }));

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      // Whole-selection rejection, surfaced through the same degradation
      // path as a generation failure — never a partial materialization.
      expect(outcome).toMatchObject({
        result: null,
        reason: expect.stringContaining('selector_failed'),
      });
      expect(outcome!.reason).toContain('not in the candidate manifest');
    });

    it('caps the request text handed to the selector', async () => {
      // The selector is a bounded pre-flight call on the critical path of
      // every request carrying media: an unbounded request text (a pasted
      // log, a huge diff) would put the main request's latency and cost at
      // the mercy of whatever the user happened to paste.
      const resourceId = await recordAndBind();
      const longQuestion = 'q'.repeat(5000);
      let seenRequest = '';
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: SelectorOptions,
      ) => {
        seenRequest = parseSelectorPayload(options).request;
        return { entryIds: [] };
      }) as never);

      await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          longQuestion,
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(seenRequest).toHaveLength(4000);
      expect(seenRequest).toBe(longQuestion.slice(0, 4000));
    });

    it('cancels the selector when the caller aborts', async () => {
      // A Ctrl-C landing inside the selector window must reach the selector
      // call: composed out of the request signal, the interrupted main
      // request would sit through the whole sideQuery.timeoutMs waiting for
      // a selection nobody will use.
      const resourceId = await recordAndBind();
      const controller = new AbortController();
      let seenSignal: AbortSignal | undefined;
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: SelectorOptions,
      ) => {
        seenSignal = options.abortSignal;
        controller.abort();
        throw new Error('aborted');
      }) as never);

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
        signal: controller.signal,
      });

      expect(seenSignal?.aborted).toBe(true);
      // A user abort is not the bounded window elapsing.
      expect(outcome?.reason).toContain('selector_failed');
    });

    it('reports selector_timeout when the bounded window elapses', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: SelectorOptions,
      ) => {
        await new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        });
      }) as never);

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig('sideQuery', { timeoutMs: 5 }),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({
        result: null,
        reason: 'selector_timeout',
      });
    });

    it('attributes the selector call to the originating prompt', async () => {
      // Without the promptId the selector's model traffic is logged under a
      // synthetic id, detaching this pre-flight call's cost and failures
      // from the request that caused them.
      const resourceId = await recordAndBind();
      let seenPromptId: string | undefined;
      runSideQueryMock.mockImplementation((async (
        _config: unknown,
        options: SelectorOptions,
      ) => {
        seenPromptId = options.promptId;
        return { entryIds: [] };
      }) as never);

      await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
        promptId: 'session-abc########3',
      });

      expect(seenPromptId).toBe('session-abc########3');
    });

    it('treats an empty selection as nothing to inject', async () => {
      const resourceId = await recordAndBind();
      runSideQueryMock.mockResolvedValue({ entryIds: [] } as never);

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('pic.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({
        result: null,
        reason: 'selector_selected_nothing',
      });
    });

    it('skips the selector entirely when memory has no candidates', async () => {
      // Bind a handle whose version was never persisted (empty store).
      const resourceId = registry.bind({
        fileId: 'f1',
        fileVersionId: 'v1',
        rootFileId: 'f1',
        fileRef: path.join(tmpDir, 'ghost.png'),
        mediaType: 'image',
      }).resourceId;

      const outcome = await runOmniMemorySideQuery({
        config: sideQueryConfig(),
        requestParts: [
          { text: formatResourceHandleText('ghost.png', resourceId) },
        ],
      });

      expect(outcome).toMatchObject({ result: null, reason: 'no_candidates' });
      expect(runSideQueryMock).not.toHaveBeenCalled();
    });
  });
});
