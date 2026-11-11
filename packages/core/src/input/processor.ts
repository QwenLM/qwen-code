/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Core 6-stage input processing pipeline.
 *
 * `processUserInput()` is the single shared entry point for both TUI and SDK
 * paths. It transforms raw user input into a set of `Message[]` ready to be
 * appended to the conversation history before the next API call.
 *
 * Stages:
 *   0. Input normalisation (string | ModelInputContentBlock[])
 *   1. PastedContent image pipeline (resize + store + metadata)
 *   2. bridgeOrigin safety gate (limit dangerous slash commands from SDK)
 *   3. Pre-routing intercepts (ultraplan keyword detection)
 *   4. Attachment collection (getAttachmentMessages; deferred for bash)
 *   5. Branch routing (bash / slash-command / text-prompt)
 *   6. Image metadata annotation message
 */

import path from 'node:path';
import { getSkillListingConfig } from '../attachments/generators/skill-generators.js';
import { getModelVisibleSkillsForTools } from '../workflows/workflow-skills.js';
import { randomUUID } from 'node:crypto';

import type { Message } from '../protocol/transcript/message.js';
import type {
  ModelImageBlock,
  ModelInputContentBlock,
  ModelStreamUserContent,
} from '../provider/modelStreamRequest.js';

import {
  createUserMessage,
  createSystemMessage,
  modelInputToTranscriptBlock,
} from '../protocol/transcript/conversions.js';
import { getAttachmentMessages } from '../attachments/get-attachments.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import type { AttachmentMessage } from '../attachments/types.js';
import { snapshotAttachmentDeltaState } from '../attachments/transcript-state.js';
import {
  SKILL_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../tools/tool-names.js';
import { HookEventName, truncateHookOutput } from '../hooks/types.js';

import {
  ImageResizeError,
  decodeBase64ImageData,
  maybeResizeAndDownsampleImageBuffer,
  createImageMetadataText,
} from '../utils/imageReader.js';
import { extractUserVisiblePromptText } from '../utils/promptTextUtils.js';

import {
  filterOrphanedImages,
  parseImagePlaceholderIds,
  restoreImagePlaceholderText,
} from './text-expander.js';
import {
  processPastedImages,
  addImageMetadataMessage,
} from './image-pipeline.js';
import type { DegradedPastedImage } from './image-pipeline.js';
import { coreEvents } from '../utils/events.js';
import { prepareImageBlocks, type ImagePreparationContext } from '../hooks/imagePrepare.js';
import type {
  ProcessInputRequest,
  ProcessInputResult,
  ProcessInputContext,
} from './types.js';
import {
  activateSelectedSkills,
  SelectedSkillActivationError,
} from '../skills/selectedSkillActivation.js';

// ---------------------------------------------------------------------------
// Extended context — routing callbacks injected by the CLI layer
// ---------------------------------------------------------------------------

/**
 * Extended context that adds optional CLI-specific routing callbacks to
 * `ProcessInputContext`.
 *
 * Both callbacks are optional. When absent:
 *   - `onBashCommand` → bash input is treated as a noop (shouldQuery: false).
 *   - `onSlashCommand` → slash input is treated as a plain text prompt (model receives it).
 */
export interface ProcessInputFullContext extends ProcessInputContext {
  /**
   * Execute a bash/shell command.
   * Called when `commandMode === 'bash'`.
   * Model-facing attachments are collected centrally after this callback
   * confirms `shouldQuery`, so `attachmentMessages` is empty on this route.
   * Returns `{ messages: [], shouldQuery: false }` if omitted.
   */
  onBashCommand?: (
    input: string,
    attachmentMessages: AttachmentMessage[],
  ) => Promise<ProcessInputResult>;

  /**
   * Execute a slash command (TUI commands like /model, /compact, etc.).
   * Called when input starts with `/` and `skipSlashCommands` is false.
   * Falls through to text-prompt routing if omitted.
   */
  onSlashCommand?: (
    input: string,
    precedingInputBlocks: readonly ModelInputContentBlock[],
    imageContentBlocks: readonly ModelInputContentBlock[],
    attachmentMessages: AttachmentMessage[],
  ) => Promise<ProcessInputResult | false>;

  /**
   * Resolve whether a slash command from a bridge/remote client is safe to run.
   * Unknown slash input returns `null` and stays plain text.
   */
  onBridgeSlashCommand?: (
    input: string,
  ) =>
    | Promise<{ allow: true } | { allow: false; message: string } | null>
    | { allow: true }
    | { allow: false; message: string }
    | null;
}

// ---------------------------------------------------------------------------
// resizeImageBlocks — shared image resize for ModelInputContentBlock[] input
// ---------------------------------------------------------------------------

/**
 * Resize and validate all image blocks in a ModelInputContentBlock[] array.
 * Invalid base64 image data rejects the operation before provider submission.
 */
export async function resizeImageBlocks(
  blocks: readonly ModelInputContentBlock[],
  options: ImagePreparationContext = {},
): Promise<{ blocks: ModelInputContentBlock[]; metadataTexts: string[] }> {
  const resized: ModelInputContentBlock[] = [];
  const metadataTexts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'image') {
      if (block.source.type !== 'base64') {
        resized.push(block);
        continue;
      }
      const buf = decodeBase64ImageData(block.source.data);
      const result = await maybeResizeAndDownsampleImageBuffer(
        buf,
        buf.length,
        block.source.mediaType.split('/')[1] ?? 'png',
      );
      const imageBlock: ModelImageBlock = {
        ...block,
        source: {
          type: 'base64',
          mediaType: `image/${result.mediaType}`,
          data: result.buffer.toString('base64'),
        },
      };
      if (result.dimensions) {
        const meta = createImageMetadataText(result.dimensions);
        if (meta) metadataTexts.push(meta);
      }
      resized.push(imageBlock);
    } else {
      resized.push(block);
    }
  }

  const uploaded = await prepareImageBlocks(resized, options);
  return { blocks: uploaded, metadataTexts };
}

function imageProcessingErrorResult(
  error: ImageResizeError,
): ProcessInputResult {
  const message =
    `Unable to attach image because it could not be decoded completely or read from its source. ` +
    `Export the original image as a new JPEG or PNG file and try again. ` +
    `Image processing error: ${error.message}`;
  return {
    messages: [createSystemMessage('error', message, 'error') as Message],
    shouldQuery: false,
    resultText: message,
    resultIsError: true,
    terminalReason: 'image_processing_failed',
    errorCode: 'IMAGE_PROCESSING_FAILED',
  };
}

/**
 * Convert an image-stage failure into a user-facing result, or rethrow if it is
 * not an image-processing error. Shared by the direct-block and pasted-image
 * stages so both surface undecodable images identically.
 */
function handleImageStageError(error: unknown): ProcessInputResult {
  if (error instanceof ImageResizeError) {
    return imageProcessingErrorResult(error);
  }
  throw error;
}

/**
 * Project processed image blocks onto the URL form exposed to submit hooks.
 * Only successfully resolved HTTP(S) image URLs are exposed. Base64 data and
 * non-HTTP URL schemes remain available to inference but are omitted here.
 */
function extractHookImageUrls(
  blocks: readonly ModelInputContentBlock[],
): string[] | undefined {
  const urls: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'image' || block.source.type !== 'url') continue;
    try {
      const protocol = new URL(block.source.url).protocol;
      if (protocol === 'http:' || protocol === 'https:') {
        urls.push(block.source.url);
      }
    } catch {
      // Invalid and non-resolved image references are not part of image_urls.
    }
  }
  return urls.length > 0 ? urls : undefined;
}

// ---------------------------------------------------------------------------
// Pasted-path text fallback
// ---------------------------------------------------------------------------

/** Map each degraded paste ID to the path text that replaces its placeholder. */
function buildDegradedPlaceholderTexts(
  degraded: readonly DegradedPastedImage[],
): ReadonlyMap<number, string> {
  return new Map(degraded.map((image) => [image.id, image.sourcePath]));
}

/**
 * Rewrite `[Image #N]` placeholders of degraded pastes back to their path text,
 * for both plain-string and block-array input.
 */
function restoreDegradedPlaceholders(
  input: ModelStreamUserContent,
  replacements: ReadonlyMap<number, string>,
): ModelStreamUserContent {
  if (typeof input === 'string') {
    return restoreImagePlaceholderText(input, replacements);
  }
  return input.map((block) =>
    block.type === 'text'
      ? {
          ...block,
          text: restoreImagePlaceholderText(block.text, replacements),
        }
      : block,
  );
}

/**
 * Report the fallback out of band. The turn itself keeps going, so this must not
 * enter the transcript as an error result.
 */
function notifyDegradedPastedImages(
  degraded: readonly DegradedPastedImage[],
): void {
  const paths = degraded.map((image) => image.sourcePath).join(', ');
  coreEvents.emitFeedback(
    'warning',
    `No readable image found, kept as plain text: ${paths}`,
    undefined,
    { omitFromTranscript: true },
  );
}

// ---------------------------------------------------------------------------
// processUserInput — main entry point
// ---------------------------------------------------------------------------

export async function processUserInput(
  request: ProcessInputRequest,
  context: ProcessInputFullContext,
): Promise<ProcessInputResult> {
  // Attachments generated for a rejected or failed input never reach history,
  // so generators must not keep treating them as announced.
  const restoreAttachmentDeltaState = snapshotAttachmentDeltaState(
    context.attachmentCtx,
  );
  try {
    return await processUserInputWithBaseline(
      request,
      context,
      restoreAttachmentDeltaState,
    );
  } catch (error) {
    restoreAttachmentDeltaState();
    throw error;
  }
}

async function processUserInputWithBaseline(
  request: ProcessInputRequest,
  context: ProcessInputFullContext,
  restoreAttachmentDeltaState: () => void,
): Promise<ProcessInputResult> {
  const {
    input,
    preExpansionInput: _preExpansionInput,
    suppressWorkflowKeyword,
    commandMode,
    pastedContents: rawPastedContents,
    uuid,
    promptId,
    requestSetId,
    isMeta,
    isVisibleInTranscriptOnly,
    skipAttachments = false,
    skipSlashCommands = false,
    selectedSkills,
    bridgeOrigin = false,
    querySource,
  } = request;

  /**
   * Whether a human typed this into the local composer.
   *
   * `querySource` alone does not say that — it names a transport, not an
   * author. Inbound cross-session messages flush through this same path
   * carrying `querySource: 'tui'`, and `injectPeerFilePrefix` deliberately
   * prefixes them with `@"path"` refs so the mention pipeline reads them. So
   * without `!isMeta` a peer could put `@name` in a message body and have this
   * session inject a reminder naming a SendMessage token back at it — two
   * sessions steering each other. `commandMode === 'prompt'` additionally
   * excludes bash mode, where `@` is shell syntax rather than prose.
   *
   * Computed once, here, so every call site downstream passes a value that is
   * true of the data rather than re-deriving the rule or faking an input to it.
   */
  const isTuiPrompt =
    querySource === 'tui' &&
    commandMode === 'prompt' &&
    !isMeta &&
    !bridgeOrigin;
  const isRegularUserPrompt = commandMode === 'prompt' && !isMeta;

  if (selectedSkills?.length && commandMode !== 'prompt') {
    throw new SelectedSkillActivationError(
      'selected_skills can only be combined with prompt input.',
    );
  }

  const { config, sessionId } = context;

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 0: Input normalisation
  // ──────────────────────────────────────────────────────────────────────────

  let inputString: string | null = null;
  let normalizedInput: ModelStreamUserContent = input;
  let precedingInputBlocks: ModelInputContentBlock[] = [];
  const stage0MetadataTexts: string[] = [];

  if (typeof input === 'string') {
    inputString = input;
  } else if (input.length > 0) {
    let processedBlocks: ModelInputContentBlock[];
    let metadataTexts: string[];
    try {
      ({ blocks: processedBlocks, metadataTexts } = await resizeImageBlocks(
        input,
        {
          signal: context.signal,
          config,
        },
      ));
    } catch (error) {
      return handleImageStageError(error);
    }
    stage0MetadataTexts.push(...metadataTexts);

    normalizedInput = processedBlocks;

    // Extract inputString from last text block
    const lastBlock = processedBlocks[processedBlocks.length - 1];
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text;
      precedingInputBlocks = processedBlocks.slice(0, -1);
    } else {
      // No trailing text block — all blocks are "preceding"
      precedingInputBlocks = processedBlocks;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 1: PastedContent image pipeline (TUI path only)
  // ──────────────────────────────────────────────────────────────────────────

  let imageContentBlocks: ModelInputContentBlock[] = [];
  let imagePasteIds: number[] = [];
  const stage1MetadataTexts: string[] = [];

  if (rawPastedContents) {
    // Run orphan filter: drop images whose [Image #N] was deleted from input
    const finalInput = typeof input === 'string' ? input : (inputString ?? '');
    const filteredPastedContents = filterOrphanedImages(
      rawPastedContents,
      finalInput,
    );

    const hasImages = Object.values(filteredPastedContents).some(
      (c) => c.type === 'image',
    );

    if (hasImages) {
      // Session images directory: <projectTempDir>/images/<sessionId>/
      const projectTempDir = config.storage.getProjectTempDir();
      const sessionImagesDir = path.join(projectTempDir, 'images', sessionId);

      // Ordered by [Image #N] appearance in the input string
      const orderedIds =
        typeof input === 'string' ? parseImagePlaceholderIds(input) : undefined;

      let degradedImages: DegradedPastedImage[] = [];
      try {
        const pipeline = await processPastedImages(
          filteredPastedContents,
          sessionImagesDir,
          orderedIds,
          context.signal,
          { config },
        );

        imageContentBlocks = pipeline.imageContentBlocks;
        imagePasteIds = pipeline.imagePasteIds;
        stage1MetadataTexts.push(...pipeline.imageMetadataTexts);
        degradedImages = pipeline.degradedImages;
      } catch (error) {
        return handleImageStageError(error);
      }

      // A pasted path that is not a readable image (typo, unreachable share,
      // deleted file) carries no image bytes, but it is still valid text the
      // user typed. Put the path back into the prompt instead of rejecting the
      // whole turn, and tell the user out of band.
      if (degradedImages.length > 0) {
        const placeholderTexts = buildDegradedPlaceholderTexts(degradedImages);
        normalizedInput = restoreDegradedPlaceholders(
          normalizedInput,
          placeholderTexts,
        );
        if (inputString !== null) {
          inputString = restoreImagePlaceholderText(
            inputString,
            placeholderTexts,
          );
        }
        notifyDegradedPastedImages(degradedImages);
      }
    }
  }

  const userVisibleInputString = extractUserVisiblePromptText(normalizedInput);

  // Combined metadata for Stage 6
  const allImageMetadataTexts = [
    ...stage0MetadataTexts,
    ...stage1MetadataTexts,
  ];
  const hookImageBlocks = [
    ...(typeof normalizedInput === 'string' ? [] : normalizedInput),
    ...imageContentBlocks,
  ];
  const hasImageInput = hookImageBlocks.some((block) => block.type === 'image');
  const hookImageUrls = extractHookImageUrls(hookImageBlocks);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 2: bridgeOrigin safety gate
  // ──────────────────────────────────────────────────────────────────────────

  let effectiveSkipSlash = skipSlashCommands;

  if (bridgeOrigin && inputString?.startsWith('/')) {
    const bridgeDecision = await context.onBridgeSlashCommand?.(inputString);
    if (bridgeDecision?.allow === true) {
      effectiveSkipSlash = false;
    } else if (bridgeDecision?.allow === false) {
      const bridgeUserMessage = createUserMessage(inputString, {
        uuid: uuid ?? randomUUID(),
        permissionMode: config.getPermissionMode(),
      }) as Message;
      return finalizeInputResult(
        {
          messages: [
            bridgeUserMessage,
            createSystemMessage(
              'error',
              bridgeDecision.message,
              'error',
            ) as Message,
          ],
          shouldQuery: false,
          resultText: bridgeDecision.message,
          resultIsError: true,
        },
        allImageMetadataTexts,
        inputString,
        promptId,
        hookImageUrls,
        hasImageInput,
        context,
        requestSetId,
        restoreAttachmentDeltaState,
      );
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 3: Pre-routing intercepts (ultraplan keyword)
  // ──────────────────────────────────────────────────────────────────────────

  // Note: Ultraplan is a feature-flag-gated capability. When the flag is active
  // and the user's input (pre-expansion) contains the trigger keyword, we rewrite
  // the prompt and route to /ultraplan. This stub is where that logic lives.
  // The feature flag check (`feature('ULTRAPLAN')`) is intentionally omitted here
  // as the flag system is CLI-specific; pass ultraplan detection via context if needed.

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 4: Attachment collection
  // ──────────────────────────────────────────────────────────────────────────

  // A bash command may complete locally without a model request. Defer
  // attachment generation until the handler confirms otherwise so it can
  // first lock any model-facing process policy (such as MCP lazy mode).
  const isBashInput = commandMode === 'bash' && inputString !== null;
  const collectCurrentAttachmentMessages = () =>
    collectAttachmentMessages({
      inputString,
      preExpansionInput: _preExpansionInput ?? inputString,
      skipAttachments,
      commandMode,
      effectiveSkipSlash,
      context,
      querySource,
      promptId,
      isTuiPrompt,
      isRegularUserPrompt,
      suppressWorkflowKeyword,
    });
  let attachmentMessages = isBashInput
    ? []
    : await collectCurrentAttachmentMessages();

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 5: Branch routing
  // ──────────────────────────────────────────────────────────────────────────

  let result: ProcessInputResult;

  // ── Bash mode ──
  if (commandMode === 'bash' && inputString !== null) {
    if (context.onBashCommand) {
      result = await context.onBashCommand(inputString, attachmentMessages);
    } else {
      // No bash handler (e.g. SDK path) — noop
      result = { messages: [], shouldQuery: false };
    }
    if (result.shouldQuery) {
      // The handler has completed its model-request preparation. Generate the
      // attachments against that final state and keep them with this request.
      attachmentMessages = await collectCurrentAttachmentMessages();
      result = {
        ...result,
        messages: [...result.messages, ...attachmentMessages],
      };
    }
    return finalizeInputResult(
      result,
      allImageMetadataTexts,
      userVisibleInputString,
      promptId,
      hookImageUrls,
      hasImageInput,
      context,
      requestSetId,
      restoreAttachmentDeltaState,
    );
  }

  // ── Slash command ──
  if (
    inputString !== null &&
    inputString.trim().startsWith('/') &&
    !effectiveSkipSlash
  ) {
    if (context.onSlashCommand) {
      const slashResult = await context.onSlashCommand(
        inputString,
        precedingInputBlocks,
        imageContentBlocks,
        attachmentMessages,
      );
      if (slashResult === false) {
        attachmentMessages = await collectAttachmentMessages({
          inputString,
          preExpansionInput: _preExpansionInput ?? inputString,
          skipAttachments,
          commandMode,
          effectiveSkipSlash,
          context,
          querySource,
          promptId,
          isTuiPrompt,
          isRegularUserPrompt,
          suppressWorkflowKeyword,
          forceTextPrompt: true,
        });
        result = processTextPrompt(
          normalizedInput,
          imageContentBlocks,
          imagePasteIds,
          attachmentMessages,
          uuid,
          config.getPermissionMode(),
          isMeta,
          isVisibleInTranscriptOnly,
        );
        result = await activateSelectedSkillsForPrompt(
          result,
          selectedSkills,
          context,
        );
      } else {
        if (selectedSkills?.length) {
          throw new SelectedSkillActivationError(
            'selected_skills cannot be combined with a handled slash command. Send the slash-prefixed text as literal prompt input instead.',
          );
        }
        result = await addPostSlashAttachmentsIfNeeded({
          slashResult,
          fallbackInputString: inputString,
          preExpansionInput: _preExpansionInput ?? inputString,
          skipAttachments,
          commandMode,
          effectiveSkipSlash,
          context,
          querySource,
          promptId,
          isRegularUserPrompt,
        });
      }
    } else {
      // No slash handler — fall through to text prompt (SDK path).
      // Re-collect attachments with forceTextPrompt so slash-like input
      // does not cause collectAttachmentMessages to skip collection.
      attachmentMessages = await collectAttachmentMessages({
        inputString,
        preExpansionInput: _preExpansionInput ?? inputString,
        skipAttachments,
        commandMode,
        effectiveSkipSlash,
        context,
        querySource,
        promptId,
        isTuiPrompt,
        isRegularUserPrompt,
        forceTextPrompt: true,
      });
      result = processTextPrompt(
        normalizedInput,
        imageContentBlocks,
        imagePasteIds,
        attachmentMessages,
        uuid,
        config.getPermissionMode(),
        isMeta,
        isVisibleInTranscriptOnly,
      );
      result = await activateSelectedSkillsForPrompt(
        result,
        selectedSkills,
        context,
      );
    }
    return finalizeInputResult(
      result,
      allImageMetadataTexts,
      inputString,
      promptId,
      hookImageUrls,
      hasImageInput,
      context,
      requestSetId,
      restoreAttachmentDeltaState,
    );
  }

  // ── Text prompt (most common path) ──
  result = processTextPrompt(
    normalizedInput,
    imageContentBlocks,
    imagePasteIds,
    attachmentMessages,
    uuid,
    config.getPermissionMode(),
    isMeta,
    isVisibleInTranscriptOnly,
  );
  result = await activateSelectedSkillsForPrompt(
    result,
    selectedSkills,
    context,
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 6: Image metadata annotation
  // ──────────────────────────────────────────────────────────────────────────

  return finalizeInputResult(
    result,
    allImageMetadataTexts,
    userVisibleInputString,
    promptId,
    hookImageUrls,
    hasImageInput,
    context,
    requestSetId,
    restoreAttachmentDeltaState,
  );
}

async function activateSelectedSkillsForPrompt(
  result: ProcessInputResult,
  selectedSkills: ProcessInputRequest['selectedSkills'],
  context: ProcessInputFullContext,
): Promise<ProcessInputResult> {
  if (!selectedSkills?.length) return result;
  if (!result.shouldQuery) {
    throw new SelectedSkillActivationError(
      'selected_skills require input that starts a model query.',
    );
  }

  const activation = await activateSelectedSkills(
    context.config,
    selectedSkills,
  );
  const allowedTools = Array.from(
    new Set([
      ...(activation.allowedTools ?? []),
      ...(result.allowedTools ?? []),
    ]),
  );
  return {
    ...result,
    messages: [...activation.messages, ...result.messages],
    skillActivations: activation.skillActivations,
    ...(allowedTools.length > 0 ? { allowedTools } : {}),
    model: activation.model ?? result.model,
    effort: activation.effort ?? result.effort,
  };
}

async function addPostSlashAttachmentsIfNeeded({
  slashResult,
  fallbackInputString,
  preExpansionInput,
  skipAttachments,
  commandMode,
  effectiveSkipSlash,
  context,
  querySource,
  promptId,
  isRegularUserPrompt,
}: {
  slashResult: ProcessInputResult;
  fallbackInputString: string;
  preExpansionInput?: string | null;
  skipAttachments: boolean;
  commandMode: ProcessInputRequest['commandMode'];
  effectiveSkipSlash: boolean;
  context: ProcessInputFullContext;
  querySource: ProcessInputRequest['querySource'];
  promptId: string | undefined;
  isRegularUserPrompt: boolean;
}): Promise<ProcessInputResult> {
  if (!slashResult.shouldQuery || hasAttachmentMessage(slashResult.messages)) {
    return slashResult;
  }

  const postSlashAttachmentInput =
    slashResult.attachmentInput ?? fallbackInputString;
  const postSlashAttachments = await collectAttachmentMessages({
    inputString: postSlashAttachmentInput,
    preExpansionInput: preExpansionInput ?? fallbackInputString,
    skipAttachments,
    commandMode,
    effectiveSkipSlash,
    context,
    querySource,
    promptId,
    // The text here is what a slash command *expanded to*, not what the user
    // typed, so it is not a composer prompt. Stated directly rather than
    // reached by faking an input to the rule: the answer does not depend on the
    // caller, and a reader should not have to work out that `isMeta: true` was
    // a lever rather than a fact.
    isTuiPrompt: false,
    isRegularUserPrompt,
    forceTextPrompt: true,
  });

  if (postSlashAttachments.length === 0) {
    return slashResult;
  }

  return {
    ...slashResult,
    messages: [...slashResult.messages, ...postSlashAttachments],
  };
}

function hasAttachmentMessage(messages: readonly Message[]): boolean {
  return messages.some((message) => message.type === 'attachment');
}

async function collectAttachmentMessages({
  inputString,
  preExpansionInput,
  skipAttachments,
  commandMode,
  effectiveSkipSlash,
  context,
  querySource,
  promptId,
  isTuiPrompt,
  isRegularUserPrompt,
  suppressWorkflowKeyword = false,
  forceTextPrompt = false,
}: {
  inputString: string | null;
  preExpansionInput?: string | null;
  skipAttachments: boolean;
  commandMode: ProcessInputRequest['commandMode'];
  effectiveSkipSlash: boolean;
  context: ProcessInputFullContext;
  querySource: ProcessInputRequest['querySource'];
  promptId: string | undefined;
  /** Whether a human typed this into the local composer. */
  isTuiPrompt: boolean;
  /** Whether this is a non-meta user prompt rather than an internal turn. */
  isRegularUserPrompt: boolean;
  suppressWorkflowKeyword?: boolean;
  forceTextPrompt?: boolean;
}): Promise<AttachmentMessage[]> {
  const { attachmentCtx, config, externalContext } = context;
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (forceTextPrompt ||
      commandMode !== 'prompt' ||
      effectiveSkipSlash ||
      !inputString.startsWith('/'));

  if (!shouldExtractAttachments) {
    return [];
  }

  return getAttachmentMessages(
    inputString,
    attachmentCtx,
    [], // queuedCommands are handled at the query() layer, not here.
    getModelVisibleSkillsForTools(
      config,
      config.getToolRegistry().hasToolEnabled(SKILL_TOOL_NAME)
        ? [SKILL_TOOL_NAME]
        : [],
    ),
    {
      signal: context.signal,
      isMainThread: querySource === 'tui',
      isTuiPrompt,
      isInitialTurn: context.isInitialTurn ?? false,
      isTodoToolEnabled: config
        .getToolRegistry()
        .hasToolEnabled(WRITE_TODOS_TOOL_NAME),
      isTaskUpdateToolEnabled: config
        .getToolRegistry()
        .hasToolEnabled(TASK_UPDATE_TOOL_NAME),
      taskStore: config.isTasksEnabled() ? config.getTaskStore() : undefined,
      preExpansionInput: preExpansionInput ?? inputString,
      suppressWorkflowKeyword,
      workflowKeywordTriggerEnabled: config.getWorkflowKeywordTriggerEnabled(),
      ultracodeActive: config.isUltracodeActive(
        await config.getModelProviderManager().getModel(config.getModel()),
      ),
      // ACP does not inherit new interactive/session policies implicitly.
      ultracodeRegularUserPrompt: querySource !== 'acp' && isRegularUserPrompt,
      skillListingConfig: await getSkillListingConfig(config),
      diagnostics: {
        sessionId: context.sessionId,
        turnId: promptId,
        phase: forceTextPrompt ? 'input.slash_fallthrough' : 'input.pre_route',
      },
    },
    externalContext,
    config.planStateManager,
    context.messages,
  );
}

async function finalizeInputResult(
  result: ProcessInputResult,
  imageMetadataTexts: string[],
  inputString: string | null,
  promptId: string | undefined,
  imageUrls: readonly string[] | undefined,
  hasImageInput: boolean,
  context: ProcessInputFullContext,
  requestSetId: string | undefined,
  restoreAttachmentDeltaState: () => void,
): Promise<ProcessInputResult> {
  const withImageMetadata = addImageMetadataMessage(result, imageMetadataTexts);
  if (promptId) {
    for (const message of withImageMetadata.messages) {
      if (message.type === 'user' && !message.promptId) {
        message.promptId = promptId;
      }
    }
  }
  return applyBeforeHook(
    withImageMetadata,
    inputString,
    promptId,
    imageUrls,
    hasImageInput,
    context,
    requestSetId,
    restoreAttachmentDeltaState,
  );
}

async function applyBeforeHook(
  result: ProcessInputResult,
  inputString: string | null,
  promptId: string | undefined,
  imageUrls: readonly string[] | undefined,
  hasImageInput: boolean,
  context: ProcessInputFullContext,
  requestSetId: string | undefined,
  restoreAttachmentDeltaState: () => void,
): Promise<ProcessInputResult> {
  if (!result.shouldQuery || !promptId || (!inputString && !hasImageInput)) {
    return result;
  }

  const hookPrompt = inputString ?? '';
  const hookResult = await context.hookCoordinator.fireBefore(
    promptId,
    hookPrompt,
    imageUrls,
    requestSetId,
    ...(context.signal ? ([context.signal] as const) : ([] as const)),
  );
  if (!hookResult) {
    return result;
  }

  const hookAttachmentMessages =
    hookResult.pendingAttachments?.map((attachment) =>
      createAttachmentMessage(attachment),
    ) ?? [];

  if (hookResult.blocked) {
    restoreAttachmentDeltaState();
    return {
      ...result,
      messages: [
        ...hookAttachmentMessages,
        createSystemMessage(
          'error',
          'Agent execution blocked by hook',
          'error',
        ) as Message,
      ],
      shouldQuery: false,
    };
  }

  if (hookResult.stopped) {
    const stopMsg = hookResult.stopReason
      ? `Operation stopped by hook: ${hookResult.stopReason}`
      : 'Operation stopped by hook';
    const stopMessage = createUserMessage(stopMsg, { isMeta: true }) as Message;
    if (stopMessage.type === 'user') {
      stopMessage.promptId = promptId;
    }
    return {
      ...result,
      messages: [...result.messages, ...hookAttachmentMessages, stopMessage],
      shouldQuery: false,
      hookStop: {
        ...(hookResult.stopReason ? { stopReason: hookResult.stopReason } : {}),
      },
    };
  }

  if (hookResult.sessionTitle && context.config.persistSessionTitle) {
    await context.config.persistSessionTitle(hookResult.sessionTitle);
  }

  if (
    hookResult.stdoutForModel &&
    !hookResult.suppressOutput &&
    context.attachmentCtx
  ) {
    context.attachmentCtx.pendingHookOutputs.push({
      hookEventName: HookEventName.UserPromptSubmit,
      output: hookResult.stdoutForModel,
      sourceType: 'stdout',
    });
  }

  if (hookResult.additionalContext && context.attachmentCtx) {
    context.attachmentCtx.pendingHookOutputs.push({
      hookEventName: HookEventName.UserPromptSubmit,
      output: truncateHookOutput(hookResult.additionalContext),
      sourceType: 'additionalContext',
    });
  }

  if (hookAttachmentMessages.length > 0) {
    return {
      ...result,
      messages: [...result.messages, ...hookAttachmentMessages],
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// processTextPrompt — build the standard UserMessage + attachments
// ---------------------------------------------------------------------------

function processTextPrompt(
  normalizedInput: ModelStreamUserContent,
  imageContentBlocks: readonly ModelInputContentBlock[],
  imagePasteIds: number[],
  attachmentMessages: AttachmentMessage[],
  uuid?: string,
  permissionMode?: string,
  isMeta?: boolean,
  isVisibleInTranscriptOnly?: boolean,
): ProcessInputResult {
  // Build message content
  let content: ModelStreamUserContent;

  if (typeof normalizedInput === 'string') {
    if (imageContentBlocks.length === 0) {
      // Pure text
      content = normalizedInput;
    } else {
      // Text + images
      const blocks: ModelInputContentBlock[] = [
        { type: 'text', text: normalizedInput },
        ...imageContentBlocks,
      ];
      content = blocks;
    }
  } else {
    // ModelInputContentBlock[] path: append image blocks at the end
    content =
      imageContentBlocks.length > 0
        ? [...normalizedInput, ...imageContentBlocks]
        : normalizedInput;
  }

  const userMsg = createUserMessage(
    typeof content === 'string'
      ? content
      : content.map(modelInputToTranscriptBlock),
    {
      uuid: uuid ?? randomUUID(),
      isMeta,
      isVisibleInTranscriptOnly,
      origin: { kind: 'human' },
      permissionMode,
    },
  );

  return {
    messages: [userMsg, ...attachmentMessages],
    shouldQuery: true,
  };
}
