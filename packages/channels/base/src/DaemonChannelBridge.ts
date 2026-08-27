import { EventEmitter } from 'node:events';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  CHANNEL_PROMPT_AUTHORIZATION_META_KEY,
  CHANNEL_PROMPT_DISPLAY_TEXT_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  resolvePromptImages,
  type AvailableCommand,
  type BridgeSessionInfo,
  type ChannelAgentBridge,
  type ChannelAgentBridgePromptOptions,
  type ChannelAgentBridgeSessionOptions,
  type ChannelLoopToolHandler,
  type ToolCallEvent,
} from './ChannelAgentBridge.js';
import { readAvailableCommandAltNames } from './AcpBridge.js';
import { sanitizeLogText } from './sanitize.js';
import {
  ChannelLoopMcpServer,
  type JsonRpcMessage,
} from './ChannelLoopTools.js';
import type { SessionScope } from './types.js';

const MAX_RESPONDED_PERMISSION_REQUESTS = 256;

export interface DaemonChannelEvent {
  id?: number;
  v: 1;
  type: string;
  data: unknown;
  originatorClientId?: string;
}

export interface DaemonChannelSessionClient {
  readonly sessionId: string;
  readonly workspaceCwd: string;
  readonly lastEventId?: number;
  prompt(
    req: {
      prompt: Array<Record<string, unknown>>;
      _meta?: Record<string, unknown>;
    },
    signal?: AbortSignal,
  ): Promise<{ stopReason?: string; [key: string]: unknown }>;
  uploadAttachment?(
    data: Blob,
    name: string,
    mimeType: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  removeAttachment?(attachmentId: string): Promise<boolean>;
  events(opts?: {
    signal?: AbortSignal;
    lastEventId?: number;
    resume?: boolean;
  }): AsyncGenerator<DaemonChannelEvent>;
  detach?(): Promise<void>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<Record<string, unknown>>;
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
  shellCommand?(
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }>;
}

export interface DaemonChannelSessionFactoryRequest {
  workspaceCwd: string;
  modelServiceId?: string;
  sessionId?: string;
  sessionScope?: SessionScope;
  approvalMode?: string;
  /** Channel instance name stamped as daemon `sourceId`. */
  sourceId?: string;
}

export type DaemonChannelSessionFactory = (
  req: DaemonChannelSessionFactoryRequest,
) => Promise<DaemonChannelSessionClient>;

export interface DaemonChannelLoopMcpHost {
  register(
    sessionId: string,
    handler: (message: JsonRpcMessage) => Promise<JsonRpcMessage | undefined>,
  ): Promise<void>;
  unregister(sessionId: string): Promise<void>;
}

export interface DaemonChannelBridgeOptions {
  cwd: string;
  sessionFactory: DaemonChannelSessionFactory;
  modelServiceId?: string;
  sessionScope?: SessionScope;
  channelLoopMcpHost?: DaemonChannelLoopMcpHost;
  deleteSessionData?: (sessionId: string) => Promise<void>;
  promptAuthorization?: string;
  /**
   * The daemon advertises the `session_attachments` capability. Daemons
   * predating the attachment upload routes receive prompt images inline
   * instead, as before the upload path existed.
   */
  sessionAttachments?: boolean;
}

export interface DaemonPermissionRequestEvent {
  requestId: string;
  sessionId: string;
  request: RequestPermissionRequest;
}

export interface DaemonPermissionResolvedEvent {
  requestId: string;
  outcome?: DaemonPermissionOutcome;
}

export interface DaemonPromptCompleteEvent {
  sessionId: string;
  text: string;
  stopReason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getTextContent(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  return getString(content['text']);
}

// Mirrors the daemon attachment store's SUPPORTED_IMAGE_MIME_TYPES
// (packages/acp-bridge/src/sessionAttachments.ts): the store rejects uploads
// outside that set, and channels/base keeps no acp-bridge dependency, so the
// set is repeated here and checked before uploading.
const CHANNEL_IMAGE_EXTENSIONS = ['bmp', 'gif', 'jpeg', 'png', 'webp'];

// Mirrors the store's SESSION_ATTACHMENT_MAX_ITEM_BYTES and empty-image
// rejection (same file): checked before delivery so one inadmissible image
// degrades by omission instead of failing the whole turn.
const CHANNEL_IMAGE_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

// Daemons without `session_attachments` parse the prompt body with
// express.json({ limit: '10mb' }), so the inline fallback keeps the
// aggregate base64 payload below that cap with headroom for the text
// prompt and the JSON envelope.
const CHANNEL_IMAGE_INLINE_MAX_BASE64_BYTES = 8 * 1024 * 1024;

function channelImageName(mimeType: string, index = 0): string | undefined {
  if (!mimeType.startsWith('image/')) {
    return undefined;
  }
  const extension = mimeType.slice('image/'.length);
  if (!CHANNEL_IMAGE_EXTENSIONS.includes(extension)) {
    return undefined;
  }
  return index === 0 ? `image.${extension}` : `image-${index + 1}.${extension}`;
}

function decodeChannelImage(
  data: string,
  oversizedReason: string,
): { bytes: Buffer } | { skip: string } {
  // Valid base64 decodes to at most this many bytes, so an oversized image
  // is rejected on length alone instead of allocating a buffer the size
  // check would discard. Padding is subtracted only when the input length
  // completes a quantum: Node's decoder ignores a stray trailing '=' on
  // malformed input, and counting it would undercount the decoded size.
  let estimatedBytes = Math.floor((data.length * 3) / 4);
  if (data.length % 4 === 0) {
    if (data.endsWith('==')) estimatedBytes -= 2;
    else if (data.endsWith('=')) estimatedBytes -= 1;
  }
  if (estimatedBytes > CHANNEL_IMAGE_MAX_UPLOAD_BYTES) {
    return { skip: oversizedReason };
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength === 0) {
    return { skip: 'empty once base64-decoded' };
  }
  return { bytes };
}

/**
 * Structural match for the daemon SDK's definite prompt-admission
 * rejections: `DaemonHttpError` from the admission request itself, or
 * `DaemonPendingPromptLimitError` raised before any request. channels/base
 * keeps no dependency on the SDK, so match by shape; post-admission turn
 * errors carry `_daemonTurnError` and must NOT match — by then the daemon
 * may already have resolved the uploaded attachments.
 */
function isDefinitePromptAdmissionRejection(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  if (error['name'] === 'DaemonPendingPromptLimitError') {
    return true;
  }
  return (
    error['name'] === 'DaemonHttpError' &&
    typeof error['status'] === 'number' &&
    error['_daemonTurnError'] !== true
  );
}

function getSessionUpdate(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data['update'])) {
    return undefined;
  }
  return data['update'];
}

function isAvailableCommand(value: unknown): value is AvailableCommand {
  if (!isRecord(value) || typeof value['name'] !== 'string') return false;
  // altNames is optional; when present it MUST be a string[] (so the type guard is
  // honest). A malformed wire payload — e.g. `altNames: 5` — would otherwise survive
  // onto the command and throw at the downstream `altNames.some(...)` recognition
  // site in ChannelBase.matchAgentCommand.
  const altNames = value['altNames'];
  return (
    altNames === undefined ||
    (Array.isArray(altNames) && altNames.every((n) => typeof n === 'string'))
  );
}

function isPermissionRequestData(
  value: unknown,
): value is RequestPermissionRequest & { requestId: string } {
  if (
    !isRecord(value) ||
    typeof value['requestId'] !== 'string' ||
    !isRecord(value['toolCall']) ||
    typeof value['toolCall']['toolCallId'] !== 'string' ||
    typeof value['toolCall']['kind'] !== 'string' ||
    !Array.isArray(value['options'])
  ) {
    return false;
  }
  return value['options'].every(
    (option) => isRecord(option) && typeof option['optionId'] === 'string',
  );
}

type DaemonPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

function parsePermissionOutcome(
  value: unknown,
): DaemonPermissionOutcome | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value['outcome'] === 'cancelled') {
    return { outcome: 'cancelled' };
  }
  if (
    value['outcome'] === 'selected' &&
    typeof value['optionId'] === 'string'
  ) {
    return { outcome: 'selected', optionId: value['optionId'] };
  }
  return undefined;
}

function summarizeProtocolDetails(details: unknown): unknown {
  if (!isRecord(details)) {
    return { type: typeof details };
  }
  const summary: Record<string, unknown> = {};
  for (const key of [
    'requestId',
    'sessionId',
    'sessionUpdate',
    'modelId',
    'requestedModelId',
    'toolCallId',
    'kind',
  ]) {
    const value = details[key];
    if (typeof value === 'string') {
      summary[key] = value;
    }
  }
  return summary;
}

export class DaemonChannelBridge
  extends EventEmitter
  implements ChannelAgentBridge
{
  private readonly options: DaemonChannelBridgeOptions;
  private readonly sessions = new Map<string, DaemonChannelSessionClient>();
  private readonly sessionBindingTokens = new Map<string, object | undefined>();
  private readonly eventControllers = new Map<string, AbortController>();
  private readonly requestToSession = new Map<string, string>();
  private readonly respondedRequestToSession = new Map<string, string>();
  private readonly activePrompts = new Set<string>();
  private readonly activePromptControllers = new Map<
    string,
    Set<AbortController>
  >();
  private readonly availableCommandsBySession = new Map<
    string,
    AvailableCommand[]
  >();
  private readonly turnBarriers = new Map<string, () => void>();
  private readonly channelLoopToolHandlers: ChannelLoopToolHandler[] = [];
  private readonly registeredChannelLoopMcpSessions = new Set<string>();
  private readonly channelLoopMcpRegistrations = new Map<
    string,
    Promise<void>
  >();
  private channelLoopMcpServer: ChannelLoopMcpServer | undefined;
  private connected = false;
  private lifecycleGeneration = 0;
  private latestAvailableCommandsSessionId: string | undefined;
  private lastError: unknown;
  readonly deleteSessionData?: (sessionId: string) => Promise<void>;

  constructor(options: DaemonChannelBridgeOptions) {
    super();
    this.options = options;
    const deleteSessionData = options.deleteSessionData;
    if (deleteSessionData) {
      this.deleteSessionData = async (sessionId) => {
        await deleteSessionData(sessionId);
        this.removeSessionBinding(sessionId);
      };
    }
    this.on('error', (error) => {
      this.lastError = error;
    });
  }

  get availableCommands(): AvailableCommand[] {
    if (this.latestAvailableCommandsSessionId) {
      return (
        this.availableCommandsBySession.get(
          this.latestAvailableCommandsSessionId,
        ) ?? []
      );
    }
    return Array.from(this.availableCommandsBySession.values()).at(-1) ?? [];
  }

  get lastDaemonError(): unknown {
    return this.lastError;
  }

  getAvailableCommands(sessionId: string): AvailableCommand[] {
    return this.availableCommandsBySession.get(sessionId) ?? [];
  }

  listSessions(): BridgeSessionInfo[] {
    const result: BridgeSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      result.push({
        sessionId: session.sessionId,
        workspaceCwd: session.workspaceCwd,
        hasActivePrompt: this.activePrompts.has(session.sessionId),
      });
    }
    return result;
  }

  async start(): Promise<void> {
    this.connected = true;
  }

  async newSession(
    cwd: string,
    options?: ChannelAgentBridgeSessionOptions,
    bindingToken?: object,
  ): Promise<string> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
      sessionScope: this.options.sessionScope ?? 'thread',
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options?.sourceId ? { sourceId: options.sourceId } : {}),
    });
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      await this.rejectStaleSession(session);
    }
    this.attachSession(session, bindingToken);
    await this.registerChannelLoopMcpForSession(session.sessionId);
    return session.sessionId;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    options?: ChannelAgentBridgeSessionOptions,
    bindingToken?: object,
  ): Promise<string> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const session = await this.options.sessionFactory({
      workspaceCwd: cwd || this.options.cwd,
      modelServiceId: this.options.modelServiceId,
      sessionId,
      sessionScope: this.options.sessionScope ?? 'thread',
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options?.sourceId ? { sourceId: options.sourceId } : {}),
    });
    if (lifecycleGeneration !== this.lifecycleGeneration) {
      await this.rejectStaleSession(session);
    }
    if (session.sessionId !== sessionId) {
      void this.releaseSessionClient(session).catch((error: unknown) => {
        this.lastError = error;
      });
      throw new Error(
        `Daemon returned session ${session.sessionId} while loading ${sessionId}`,
      );
    }
    this.attachSession(session, bindingToken);
    await this.registerChannelLoopMcpForSession(session.sessionId);
    return session.sessionId;
  }

  registerChannelLoopToolHandler(handler: ChannelLoopToolHandler): void {
    if (!this.channelLoopToolHandlers.includes(handler)) {
      this.channelLoopToolHandlers.push(handler);
    }
    this.channelLoopMcpServer ??= new ChannelLoopMcpServer({
      create: (sessionId, input) =>
        this.resolveChannelLoopToolHandler(sessionId).create(sessionId, input),
      list: (sessionId) =>
        this.resolveChannelLoopToolHandler(sessionId).list(sessionId),
      cancel: (sessionId, id) =>
        this.resolveChannelLoopToolHandler(sessionId).cancel(sessionId, id),
    });
    for (const sessionId of this.sessions.keys()) {
      void this.registerChannelLoopMcpForSession(sessionId);
    }
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: ChannelAgentBridgePromptOptions,
  ): Promise<string> {
    const session = this.ensureSession(sessionId);
    if (this.activePrompts.has(sessionId)) {
      throw new Error(
        `Prompt already in flight for daemon session ${sessionId}`,
      );
    }
    this.activePrompts.add(sessionId);

    const controller = new AbortController();
    let controllers = this.activePromptControllers.get(sessionId);
    if (!controllers) {
      controllers = new Set();
      this.activePromptControllers.set(sessionId, controllers);
    }
    controllers.add(controller);

    const chunks: string[] = [];
    let slashCommandOutput = '';
    const onChunk = (sid: string, chunk: string) => {
      if (sid === sessionId) {
        chunks.push(chunk);
      }
    };
    const onSlashCommandOutput = (sid: string, chunk: string) => {
      if (sid === sessionId) {
        slashCommandOutput = chunk;
      }
    };
    const clearChunks = (sid: string) => {
      if (sid === sessionId) {
        chunks.length = 0;
        slashCommandOutput = '';
      }
    };
    const onSessionDied = (info: { sessionId: string }) => {
      if (info.sessionId === sessionId) {
        controller.abort();
      }
    };
    this.on('textChunk', onChunk);
    this.on('slashCommandOutput', onSlashCommandOutput);
    this.on('responseBoundary', clearChunks);
    this.on('sessionDied', onSessionDied);
    const turnBarrier = this.createTurnBarrier(sessionId);
    const uploadedAttachmentIds: string[] = [];
    let rollbackUploadedAttachments = false;
    const uploadAttachment = session.uploadAttachment?.bind(session);
    const removeAttachment = session.removeAttachment?.bind(session);

    try {
      const prompt: Array<Record<string, unknown>> = [];
      const images = resolvePromptImages(options);
      if (
        this.options.sessionAttachments &&
        uploadAttachment &&
        removeAttachment
      ) {
        try {
          // Fan the uploads out like the webui's attachment path: names are
          // index-disambiguated and prompt order comes from the array order,
          // so nothing serializes the uploads themselves.
          const uploads = await Promise.allSettled(
            images.map(async (image, index) => {
              const name = channelImageName(image.mimeType, index);
              if (!name) {
                // One unrecognized subtype must not fail the whole turn;
                // degrade by omission.
                process.stderr.write(
                  `[DaemonChannelBridge] skipped channel image with unsupported MIME type ${sanitizeLogText(image.mimeType, 128)} for session ${sanitizeLogText(sessionId, 128)}\n`,
                );
                return undefined;
              }
              const decoded = decodeChannelImage(
                image.data,
                'above the daemon attachment size limit',
              );
              if ('skip' in decoded) {
                process.stderr.write(
                  `[DaemonChannelBridge] skipped channel image ${decoded.skip} ${sanitizeLogText(image.mimeType, 128)} for session ${sanitizeLogText(sessionId, 128)}\n`,
                );
                return undefined;
              }
              const attachment = await uploadAttachment(
                new Blob([decoded.bytes], {
                  type: image.mimeType,
                }),
                name,
                image.mimeType,
                controller.signal,
              );
              const attachmentId = getString(attachment['attachmentId']);
              if (attachmentId) uploadedAttachmentIds.push(attachmentId);
              return attachment;
            }),
          );
          const failure = uploads.find(
            (upload): upload is PromiseRejectedResult =>
              upload.status === 'rejected',
          );
          if (failure) {
            throw failure.reason;
          }
          for (const upload of uploads) {
            if (upload.status === 'fulfilled' && upload.value) {
              prompt.push(upload.value);
            }
          }
        } catch (error) {
          rollbackUploadedAttachments = true;
          throw error;
        }
      } else {
        // Daemons without `session_attachments` take images inline.
        let inlineBase64Bytes = 0;
        for (const image of images) {
          const decoded = decodeChannelImage(
            image.data,
            'above the inline image budget',
          );
          if ('skip' in decoded) {
            process.stderr.write(
              `[DaemonChannelBridge] skipped channel image ${decoded.skip} ${sanitizeLogText(image.mimeType, 128)} for session ${sanitizeLogText(sessionId, 128)}\n`,
            );
            continue;
          }
          if (
            inlineBase64Bytes + image.data.length >
            CHANNEL_IMAGE_INLINE_MAX_BASE64_BYTES
          ) {
            process.stderr.write(
              `[DaemonChannelBridge] skipped channel image to keep the inline prompt under the daemon body limit ${sanitizeLogText(image.mimeType, 128)} for session ${sanitizeLogText(sessionId, 128)}\n`,
            );
            continue;
          }
          inlineBase64Bytes += image.data.length;
          prompt.push({
            type: 'image',
            data: image.data,
            mimeType: image.mimeType,
          });
        }
      }
      prompt.push({ type: 'text', text });
      if (controller.signal.aborted) {
        rollbackUploadedAttachments = true;
        controller.signal.throwIfAborted();
      }
      // Always presented: the daemon validates it for the channel-turn
      // classification as well as the display projection, and channel
      // prompts without display text still need the classification.
      const promptAuthorization = this.options.promptAuthorization;

      // Aborted after the uploads settled but before admission: the SDK
      // rejects an already-aborted signal with a pre-request AbortError that
      // isDefinitePromptAdmissionRejection does not match, so the uploads
      // would leak. Non-admission is certain at this point; roll back.
      if (controller.signal.aborted) {
        rollbackUploadedAttachments = true;
        throw controller.signal.reason;
      }

      let result: { stopReason?: string; [key: string]: unknown };
      try {
        result = await session.prompt(
          {
            prompt,
            _meta: {
              [CHANNEL_PROMPT_META_KEY]: true,
              ...(promptAuthorization
                ? {
                    [CHANNEL_PROMPT_AUTHORIZATION_META_KEY]:
                      promptAuthorization,
                  }
                : {}),
              ...(options?.displayText !== undefined
                ? {
                    [CHANNEL_PROMPT_DISPLAY_TEXT_META_KEY]: options.displayText,
                  }
                : {}),
            },
          },
          controller.signal,
        );
      } catch (error) {
        // Roll back only when the turn was never admitted; once admitted the
        // daemon may already have resolved the uploads.
        if (isDefinitePromptAdmissionRejection(error)) {
          rollbackUploadedAttachments = true;
        }
        throw error;
      }
      // Prefer turn_complete for deterministic chunk collection (SSE path).
      // Fall back to one event-loop tick for non-SSE prompt paths (blocking
      // HTTP, non-202 responses) where turn_complete never arrives.
      await Promise.race([
        turnBarrier,
        new Promise<void>((resolve) => setTimeout(resolve, 0)),
      ]);
      const textResult = chunks.join('') || slashCommandOutput;
      this.emit('promptComplete', {
        sessionId,
        text: textResult,
        stopReason: result.stopReason,
      } satisfies DaemonPromptCompleteEvent);
      return textResult;
    } finally {
      this.clearTurnBarrier(sessionId);
      this.off('textChunk', onChunk);
      this.off('slashCommandOutput', onSlashCommandOutput);
      this.off('responseBoundary', clearChunks);
      this.off('sessionDied', onSessionDied);
      this.activePrompts.delete(sessionId);
      controllers.delete(controller);
      if (
        controllers.size === 0 &&
        this.activePromptControllers.get(sessionId) === controllers
      ) {
        this.activePromptControllers.delete(sessionId);
      }
      if (rollbackUploadedAttachments && removeAttachment) {
        const removals = await Promise.allSettled(
          uploadedAttachmentIds.map((attachmentId) =>
            removeAttachment(attachmentId),
          ),
        );
        removals.forEach((removal, index) => {
          if (removal.status === 'rejected') {
            const reason =
              removal.reason instanceof Error
                ? removal.reason.message
                : String(removal.reason);
            process.stderr.write(
              `[DaemonChannelBridge] failed to remove channel image ${sanitizeLogText(uploadedAttachmentIds[index] ?? '', 128)} for session ${sanitizeLogText(sessionId, 128)} during rollback: ${sanitizeLogText(reason, 256)}\n`,
            );
          }
        });
      }
    }
  }

  async shellCommand(
    sessionId: string,
    command: string,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; aborted: boolean }> {
    const session = this.ensureSession(sessionId);
    if (!session.shellCommand) {
      throw new Error('Shell command not supported by this session client');
    }
    return session.shellCommand(command, signal);
  }

  async cancelSession(sessionId: string): Promise<void> {
    const session = this.ensureSession(sessionId);
    this.resolveTurnBarrier(sessionId);
    this.abortActivePrompts(sessionId);
    this.activePrompts.delete(sessionId);
    await session.cancel();
  }

  async discardSession(
    sessionId: string,
    expectedBindingToken?: object,
  ): Promise<void> {
    if (
      expectedBindingToken !== undefined &&
      this.sessionBindingTokens.get(sessionId) !== expectedBindingToken
    ) {
      return;
    }
    const session = this.removeSessionBinding(sessionId);
    if (!session) return;
    await this.releaseSessionClient(session);
  }

  private async releaseSessionClient(
    session: DaemonChannelSessionClient,
  ): Promise<void> {
    if (session.detach) {
      try {
        await session.detach();
        return;
      } catch {
        // Fall back to cancellation for clients that cannot detach cleanly.
      }
    }
    await session.cancel();
  }

  async setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    return await this.ensureSession(sessionId).setModel(modelId);
  }

  async respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean> {
    const sessionId = this.requestToSession.get(requestId);
    if (!sessionId) {
      return false;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      return false;
    }
    try {
      const accepted = await session.respondToPermission(requestId, response);
      this.requestToSession.delete(requestId);
      if (accepted) {
        this.rememberRespondedPermissionRequest(requestId, sessionId);
      } else {
        this.respondedRequestToSession.delete(requestId);
      }
      return accepted;
    } catch (error) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      throw error;
    }
  }

  stop(): void {
    this.lifecycleGeneration++;
    for (const sessionId of Array.from(this.sessions.keys())) {
      const session = this.sessions.get(sessionId);
      if (session) {
        void session.cancel().catch((error: unknown) => {
          this.lastError = error;
        });
      }
      this.dropSession(sessionId, 'bridge_stopped', false);
    }
    this.latestAvailableCommandsSessionId = undefined;
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  private attachSession(
    session: DaemonChannelSessionClient,
    bindingToken?: object,
  ): void {
    const replacedSession = this.removeSessionBinding(session.sessionId, false);
    if (replacedSession) {
      void this.releaseSessionClient(replacedSession).catch(
        (error: unknown) => {
          this.lastError = error;
        },
      );
      this.emit('sessionDied', {
        sessionId: session.sessionId,
        reason: 'session_replaced',
      });
    }

    this.sessions.set(session.sessionId, session);
    this.sessionBindingTokens.set(session.sessionId, bindingToken);
    const controller = new AbortController();
    this.eventControllers.set(session.sessionId, controller);
    void this.pumpEvents(session, controller.signal);
  }

  private async rejectStaleSession(
    session: DaemonChannelSessionClient,
  ): Promise<void> {
    void this.releaseSessionClient(session).catch((error: unknown) => {
      this.lastError = error;
    });
    throw new Error('Daemon channel bridge stopped during session creation');
  }

  private ensureSession(sessionId: string): DaemonChannelSessionClient {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No daemon session bound for ${sessionId}`);
    }
    return session;
  }

  private async pumpEvents(
    session: DaemonChannelSessionClient,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of session.events({
        signal,
        lastEventId: session.lastEventId,
        resume: true,
      })) {
        if (!this.isCurrentPump(session, signal)) {
          return;
        }
        this.handleEvent(session, event);
      }
      if (!signal.aborted && this.isCurrentPump(session, signal)) {
        this.dropSession(session.sessionId, 'stream_ended');
      }
    } catch (error) {
      if (!signal.aborted && this.isCurrentPump(session, signal)) {
        this.emit('error', error);
        this.dropSession(
          session.sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  private isCurrentPump(
    session: DaemonChannelSessionClient,
    signal: AbortSignal,
  ): boolean {
    return (
      this.sessions.get(session.sessionId) === session &&
      this.eventControllers.get(session.sessionId)?.signal === signal
    );
  }

  private handleEvent(
    session: DaemonChannelSessionClient,
    event: DaemonChannelEvent,
  ): void {
    switch (event.type) {
      case 'session_update':
        if (
          isRecord(event.data) &&
          typeof event.data['sessionId'] === 'string' &&
          event.data['sessionId'] !== session.sessionId
        ) {
          break;
        }
        this.handleSessionUpdate(session.sessionId, event.data);
        break;
      case 'permission_request':
        this.handlePermissionRequest(session.sessionId, event.data);
        break;
      case 'permission_resolved':
        this.handlePermissionResolved(session.sessionId, event.data);
        break;
      case 'model_switched':
        this.handleModelSwitched(session.sessionId, event.data);
        break;
      case 'model_switch_failed':
        this.handleModelSwitchFailed(session.sessionId, event.data);
        break;
      case 'session_died':
        this.handleSessionDied(session.sessionId, event.data);
        break;
      case 'client_evicted':
        this.dropSession(
          session.sessionId,
          this.getStringField(event.data, 'reason', 'client_evicted'),
        );
        break;
      case 'stream_error':
        this.dropSession(
          session.sessionId,
          this.getStringField(event.data, 'error', 'stream_error'),
        );
        break;
      case 'turn_complete':
        this.resolveTurnBarrier(session.sessionId);
        break;
      case 'turn_error':
        this.emitProtocolError(
          `Daemon turn error for session ${session.sessionId}`,
          event.data,
        );
        this.resolveTurnBarrier(session.sessionId);
        break;
      default:
        break;
    }
  }

  private handleSessionUpdate(sessionId: string, data: unknown): void {
    const update = getSessionUpdate(data);
    if (!update) {
      this.emitProtocolError('Malformed daemon session_update event', data);
      return;
    }

    const type = getString(update['sessionUpdate']);
    switch (type) {
      case 'agent_message_chunk': {
        const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
        if (typeof meta?.['parentToolCallId'] === 'string') {
          break;
        }
        const text = getTextContent(update['content']);
        if (meta?.['qwenDiscreteMessage'] === true) {
          if (
            meta['source'] === 'background_notification_response' &&
            meta['rewritten'] !== true &&
            text
          ) {
            this.emit('backgroundResponse', sessionId, text);
          } else if (meta['source'] === 'vision_bridge_notice' && text) {
            this.emit('textChunk', sessionId, text);
          }
          break;
        }
        if (text) {
          this.emit(
            meta?.['source'] === 'slash_command'
              ? 'slashCommandOutput'
              : 'textChunk',
            sessionId,
            text,
          );
        }
        break;
      }
      case 'agent_thought_chunk': {
        const text = getTextContent(update['content']);
        if (text) {
          this.emit('thoughtChunk', sessionId, text);
        }
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const toolCallId = getString(update['toolCallId']);
        const kind = getString(update['kind']);
        const meta = isRecord(update['_meta']) ? update['_meta'] : undefined;
        if (
          !kind &&
          toolCallId &&
          getString(update['status']) === 'in_progress' &&
          meta?.['shellProgress'] !== undefined
        ) {
          // Silent-shell liveness heartbeat: a kind-less in_progress frame
          // carrying only the id, status, and _meta.shellProgress stats.
          // Channels have no use for it — drop it without flagging the
          // session as malformed. Gate on shellProgress (matching the
          // qwen-agent and web-shell normalizer guards) so a genuinely
          // malformed kind-less tool_call still reaches emitProtocolError
          // below instead of being silently swallowed.
          break;
        }
        if (!toolCallId || !kind) {
          this.emitProtocolError(`Malformed daemon ${type} event`, update);
          break;
        }
        const event: ToolCallEvent = {
          sessionId,
          toolCallId,
          kind,
          title: getString(update['title']) ?? '',
          status: getString(update['status']) ?? 'pending',
          rawInput: isRecord(update['rawInput'])
            ? update['rawInput']
            : undefined,
        };
        if (event.status === 'pending' || event.status === 'in_progress') {
          this.emitResponseBoundary(sessionId);
        }
        this.emit('toolCall', event);
        break;
      }
      case 'plan': {
        this.emitResponseBoundary(sessionId);
        break;
      }
      case 'available_commands_update': {
        if (Array.isArray(update['availableCommands'])) {
          const commands = update['availableCommands']
            .filter(isAvailableCommand)
            .map((cmd) => {
              const altNames = readAvailableCommandAltNames(cmd);
              return altNames ? { ...cmd, altNames } : cmd;
            });
          this.availableCommandsBySession.set(sessionId, commands);
          this.latestAvailableCommandsSessionId = sessionId;
        } else {
          this.emitProtocolError(
            'Malformed daemon available_commands_update event',
            data,
          );
        }
        break;
      }
      default:
        break;
    }

    this.emit('sessionUpdate', data);
  }

  private handlePermissionRequest(sessionId: string, data: unknown): void {
    if (!isPermissionRequestData(data)) {
      this.emitProtocolError('Malformed daemon permission_request event', data);
      return;
    }
    const requestId = data['requestId'];
    this.requestToSession.set(requestId, sessionId);
    this.emitResponseBoundary(sessionId);
    this.emit('permissionRequest', {
      requestId,
      sessionId,
      request: data as unknown as RequestPermissionRequest,
    } satisfies DaemonPermissionRequestEvent);
  }

  private rememberRespondedPermissionRequest(
    requestId: string,
    sessionId: string,
  ): void {
    this.respondedRequestToSession.set(requestId, sessionId);
    while (
      this.respondedRequestToSession.size > MAX_RESPONDED_PERMISSION_REQUESTS
    ) {
      const oldestRequestId = this.respondedRequestToSession
        .keys()
        .next().value;
      if (oldestRequestId === undefined) {
        return;
      }
      this.respondedRequestToSession.delete(oldestRequestId);
    }
  }

  private handlePermissionResolved(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['requestId'] !== 'string') {
      this.emitProtocolError(
        'Malformed daemon permission_resolved event',
        data,
      );
      return;
    }
    const requestId = data['requestId'];
    const mappedSessionId =
      this.requestToSession.get(requestId) ??
      this.respondedRequestToSession.get(requestId);
    if (!mappedSessionId) {
      this.emitProtocolError(
        `Ignoring daemon permission_resolved for unknown request ${requestId}`,
        data,
      );
      return;
    }
    if (mappedSessionId !== sessionId) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      this.emitProtocolError(
        `Ignoring daemon permission_resolved for request ${requestId} from non-owning session ${sessionId}`,
        data,
      );
      return;
    }
    const outcome = parsePermissionOutcome(data['outcome']);
    if (!outcome) {
      this.requestToSession.delete(requestId);
      this.respondedRequestToSession.delete(requestId);
      this.emitProtocolError(
        'Malformed daemon permission_resolved outcome',
        data,
      );
      return;
    }
    this.requestToSession.delete(requestId);
    this.respondedRequestToSession.delete(requestId);
    this.emit('permissionResolved', {
      requestId,
      outcome,
    } satisfies DaemonPermissionResolvedEvent);
  }

  private handleModelSwitched(sessionId: string, data: unknown): void {
    if (!isRecord(data) || typeof data['modelId'] !== 'string') {
      this.emitProtocolError('Malformed daemon model_switched event', data);
      return;
    }
    this.emit('modelSwitched', {
      sessionId,
      modelId: data['modelId'],
    });
  }

  private handleModelSwitchFailed(sessionId: string, data: unknown): void {
    if (!isRecord(data)) {
      this.emitProtocolError(
        'Malformed daemon model_switch_failed event',
        data,
      );
      return;
    }
    this.emit('modelSwitchFailed', {
      sessionId,
      requestedModelId: getString(data['requestedModelId']),
      error: getString(data['error']) ?? 'model_switch_failed',
    });
  }

  private handleSessionDied(sessionId: string, data: unknown): void {
    this.dropSession(
      sessionId,
      this.getStringField(data, 'reason', 'session_died'),
    );
  }

  private dropSession(
    sessionId: string,
    reason: string,
    releaseClient = true,
  ): void {
    const session = this.removeSessionBinding(sessionId);
    if (!session) return;
    if (releaseClient) {
      void this.releaseSessionClient(session).catch((error: unknown) => {
        this.lastError = error;
      });
    }
    this.emit('sessionDied', { sessionId, reason });
  }

  private removeSessionBinding(
    sessionId: string,
    unregisterChannelLoopMcp = true,
  ): DaemonChannelSessionClient | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    this.resolveTurnBarrier(sessionId);
    this.eventControllers.get(sessionId)?.abort();
    this.eventControllers.delete(sessionId);
    this.sessions.delete(sessionId);
    this.sessionBindingTokens.delete(sessionId);
    this.abortActivePrompts(sessionId);
    this.activePrompts.delete(sessionId);
    this.availableCommandsBySession.delete(sessionId);
    if (this.latestAvailableCommandsSessionId === sessionId) {
      this.latestAvailableCommandsSessionId = Array.from(
        this.availableCommandsBySession.keys(),
      ).at(-1);
    }
    for (const [requestId, mappedSessionId] of this.requestToSession) {
      if (mappedSessionId === sessionId) {
        this.requestToSession.delete(requestId);
      }
    }
    for (const [requestId, mappedSessionId] of this.respondedRequestToSession) {
      if (mappedSessionId === sessionId) {
        this.respondedRequestToSession.delete(requestId);
      }
    }
    if (unregisterChannelLoopMcp) {
      this.unregisterChannelLoopMcpForSession(sessionId);
    }
    return session;
  }

  private async registerChannelLoopMcpForSession(
    sessionId: string,
  ): Promise<void> {
    const host = this.options.channelLoopMcpHost;
    const server = this.channelLoopMcpServer;
    if (
      !host ||
      !server ||
      this.registeredChannelLoopMcpSessions.has(sessionId)
    ) {
      return;
    }
    const pending = this.channelLoopMcpRegistrations.get(sessionId);
    if (pending) {
      await pending;
      return;
    }
    const registration = host
      .register(sessionId, (message) =>
        server.handleMessage(message, { sessionId }),
      )
      .then(async () => {
        if (this.sessions.has(sessionId)) {
          this.registeredChannelLoopMcpSessions.add(sessionId);
        } else {
          await host.unregister(sessionId);
        }
      })
      .catch((error: unknown) => {
        this.lastError = error;
      })
      .finally(() => {
        if (this.channelLoopMcpRegistrations.get(sessionId) === registration) {
          this.channelLoopMcpRegistrations.delete(sessionId);
        }
      });
    this.channelLoopMcpRegistrations.set(sessionId, registration);
    await registration;
  }

  private unregisterChannelLoopMcpForSession(sessionId: string): void {
    if (!this.registeredChannelLoopMcpSessions.delete(sessionId)) return;
    void this.options.channelLoopMcpHost
      ?.unregister(sessionId)
      .catch((error: unknown) => {
        this.lastError = error;
      });
  }

  private resolveChannelLoopToolHandler(
    sessionId: string,
  ): ChannelLoopToolHandler {
    const handler = this.channelLoopToolHandlers.find(
      (candidate) =>
        candidate.canHandle?.(sessionId) === true ||
        (this.channelLoopToolHandlers.length === 1 && !candidate.canHandle),
    );
    if (handler) return handler;
    throw new Error(`No channel loop handler matched session ${sessionId}.`);
  }

  private getStringField(
    data: unknown,
    field: string,
    fallback: string,
  ): string {
    return isRecord(data) && typeof data[field] === 'string'
      ? (data[field] as string)
      : fallback;
  }

  private abortActivePrompts(sessionId: string): void {
    const promptControllers = this.activePromptControllers.get(sessionId);
    if (!promptControllers) {
      return;
    }
    for (const controller of promptControllers) {
      controller.abort();
    }
    this.activePromptControllers.delete(sessionId);
  }

  private emitResponseBoundary(sessionId: string): void {
    this.emit('responseBoundary', sessionId);
  }

  private createTurnBarrier(sessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.turnBarriers.set(sessionId, resolve);
    });
  }

  private resolveTurnBarrier(sessionId: string): void {
    const resolve = this.turnBarriers.get(sessionId);
    if (resolve) {
      this.turnBarriers.delete(sessionId);
      resolve();
    }
  }

  private clearTurnBarrier(sessionId: string): void {
    this.turnBarriers.delete(sessionId);
  }

  private emitProtocolError(message: string, details: unknown): void {
    const error = new Error(message) as Error & { details?: unknown };
    error.details = summarizeProtocolDetails(details);
    this.emit('error', error);
  }
}
