import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Buffer } from 'node:buffer';
import {
  DWClient,
  TOPIC_CARD,
  TOPIC_ROBOT,
  EventAck,
} from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import {
  ChannelBase,
  isTerminalTaskLifecycleType,
  sanitizeLogText,
  sanitizeSenderName,
} from '@qwen-code/channel-base';
import { normalizeDingTalkMarkdown, extractTitle } from './markdown.js';
import { downloadMedia } from './media.js';
import {
  DingTalkMediaUploadError,
  findImageMarkers,
  readValidatedImage,
  replaceImageMarkers,
  stripPartialImageMarker,
  uploadDingTalkImage,
} from './outbound-image.js';
import {
  MAX_FILES_PER_RESPONSE,
  findFileMarkers,
  readValidatedFile,
  replaceFileMarkers,
  safeFileName,
  sanitizeMediaMarkersToStable,
  uploadDingTalkFile,
} from './outbound-file.js';
import {
  DingtalkConnectionManager,
  type DingtalkManagedSocket,
} from './DingtalkConnectionManager.js';
import { DingtalkInteractiveCardClient } from './interactive-card-client.js';
import {
  parseDingtalkCardActorId,
  parseDingtalkCardCallback,
  parseDingtalkInteractiveCardConfig,
  type DingtalkCardCallback,
  type DingtalkCardCallbackResult,
  type DingtalkInteractiveCardConfig,
} from './interactive-card-types.js';
import { StatusCardController } from './status-card-controller.js';
import { QuestionCardController } from './question-card-controller.js';
import { DingtalkInteractionPresenter } from './interaction-presenter.js';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  ChannelAgentBridge,
  ChannelOutputSegmentContext,
  ChannelOutputSegmentEndReason,
  ChannelTaskLifecycleEvent,
  ChannelUserInputRequestContext,
  SessionTarget,
  UserInputPresentationResult,
} from '@qwen-code/channel-base';

/**
 * Raw DingTalk message data — the SDK's RobotMessage type only covers text,
 * but DingTalk sends richer payloads for richText, picture, file, etc.
 */

interface DingTalkRichTextPart {
  type?: string;
  text?: string;
  downloadCode?: string;
  atName?: string;
}

interface DingTalkRepliedMsg {
  msgId?: string;
  msgType?: string;
  senderId?: string;
  content?: {
    text?: string;
    richText?: DingTalkRichTextPart[];
    downloadCode?: string;
    fileName?: string;
  };
}

interface DingTalkAtUser {
  dingtalkId?: string;
  staffId?: string;
}

interface DingTalkMessageData {
  msgId?: string;
  msgtype?: string;
  conversationType?: string;
  conversationId?: string;
  conversationTitle?: string;
  sessionWebhook?: string;
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  chatbotUserId?: string;
  isInAtList?: boolean;
  atUsers?: DingTalkAtUser[];
  text?: {
    content?: string;
    isReplyMsg?: boolean;
    repliedMsg?: DingTalkRepliedMsg;
  };
  quoteMessage?: {
    msgId?: string;
    senderId?: string;
    text?: { content?: string };
    msgtype?: string;
  };
  content?: {
    richText?: DingTalkRichTextPart[];
    downloadCode?: string;
    fileName?: string;
    recognition?: string;
  };
}

/** Track seen msgIds to deduplicate retried callbacks. */
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACK_REACTION_NAME = '👀';
const ACK_EMOTION_ID = '2659900';
const ACK_EMOTION_BG_ID = 'im_bg_1';
const EMOTION_API = 'https://api.dingtalk.com/v1.0/robot/emotion';
const EMOTION_MAX_ATTEMPTS = 3;
const EMOTION_RETRY_BASE_DELAY_MS = 250;
const GROUP_MSG_API = 'https://api.dingtalk.com/v1.0/robot/groupMessages/send';
const DIRECT_MSG_API =
  'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';
const ROBOT_TOKEN_API = 'https://api.dingtalk.com/v1.0/oauth2/accessToken';
const PROACTIVE_MSG_KEY = 'sampleMarkdown'; // DingTalk's built-in {title, text} markdown template key
const PROACTIVE_FILE_MSG_KEY = 'sampleFile';
const TOKEN_API = 'https://oapi.dingtalk.com/gettoken';
const PROACTIVE_FETCH_TIMEOUT_MS = 15_000;
const ROBOT_MESSAGE_HOSTS = new Set(['api.dingtalk.com', 'oapi.dingtalk.com']);
// Extensions for generated media store names, keyed by the download's mime
// type. The agent reads stored media via `read_file`, whose type detection is
// extension-first: an extensionless name falls through to the binary content
// sampler and real image/audio/video bytes are refused.
const GENERATED_MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};
const mentionTarget = Symbol('mentionTarget');
const IMAGE_INSTRUCTIONS = [
  '',
  'If you created an image file (screenshot, chart, etc.), you can send it to the user by writing:',
  '`[IMAGE: /absolute/path/to/file.png]` (without the backticks)',
  '',
  'The marker is stripped from text and the image is uploaded automatically.',
  '',
  'Only use a real image file inside the workspace or system temporary directory.',
].join('\n');
const FILE_INSTRUCTIONS = [
  '',
  'If the user explicitly asks you to send a file that exists inside the workspace or system temporary directory, include this in the final answer:',
  '`[FILE: /absolute/path/to/file]` (without the backticks)',
  '',
  'Use the marker only after the file is complete. Do not use it in progress text, inside code, or before asking the user for input.',
  'The whole marker must sit on one line, and the path must not contain `[` or `]`. If it does, copy the file to a path without brackets first.',
  'Do not claim that delivery succeeded; DingTalk will show the file as a separate attachment.',
].join('\n');

type MentionTargetEnvelope = Envelope & {
  [mentionTarget]?: string;
};

interface CardRunCorrelation {
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  sender?: { senderName: string };
}

function collectNonBotMentionIds(data: DingTalkMessageData): string[] {
  if (!Array.isArray(data.atUsers) || typeof data.chatbotUserId !== 'string') {
    return [];
  }

  const mentions = new Set<string>();
  for (const user of data.atUsers) {
    if (!user) continue;
    const dingtalkId =
      typeof user.dingtalkId === 'string' ? user.dingtalkId : undefined;
    // DingTalk Stream always sets dingtalkId for the bot entry; staffId-only bot entries are not expected.
    if (dingtalkId === data.chatbotUserId) continue;
    const staffId = typeof user.staffId === 'string' ? user.staffId : undefined;
    // Prefer staffId so the model sees the same identifier space as senderId.
    const stableId = staffId || dingtalkId;
    if (stableId) mentions.add(stableId);
  }

  return [...mentions];
}

interface DingTalkTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface DingTalkDirectMessageResponse {
  flowControlledStaffIdList?: string[];
  invalidStaffIdList?: string[];
  processQueryKey?: string;
}

interface DingTalkRobotTokenResponse {
  accessToken?: string;
  expireIn?: number;
}

interface PreparedDingTalkFile {
  mediaId: string;
  fileName: string;
  fileType: string;
}

interface PreparedDingTalkOutput {
  text: string;
  files: PreparedDingTalkFile[];
}

type DingTalkClientInternals = DWClient & {
  debug: boolean;
  onDownStream(data: unknown): void;
  onSystem(message: DWClientDownStream): void;
  onEvent(message: DWClientDownStream): void;
  onCallback(message: DWClientDownStream): void;
};

type DingtalkChannelConfig = ChannelConfig & {
  useConnectionManager?: unknown;
  interactiveCards?: unknown;
};

/**
 * The non-zero `errcode`/`code` a DingTalk webhook returns alongside HTTP 200
 * when it rejects a post, or `undefined` when the response carries no verdict.
 *
 * A body that is absent or is not JSON is not a rejection: some deployments
 * answer a successful post with a bare `ok`, and inventing a failure from an
 * unparseable body would drop messages that did arrive. Only an explicit
 * non-zero code counts.
 */
async function readDingTalkErrorCode(
  resp: Response,
): Promise<string | undefined> {
  const text = await resp
    .clone()
    .text()
    .catch(() => '');
  if (!text.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const data = parsed as Record<string, unknown>;
  for (const value of [data['errcode'], data['code']]) {
    if (value !== undefined && String(value) !== '0') {
      return sanitizeLogText(String(value), 80);
    }
  }
  return undefined;
}

export class DingtalkChannel extends ChannelBase {
  private client: DWClient;
  private readonly atSender: boolean;
  private connectionManager?: DingtalkConnectionManager<DWClient>;
  private seenMessages: Map<string, number> = new Map();
  private mentionTargets = new Map<string, string>();
  private sessionMentionTargets = new Map<string, string>();
  private bufferedMentionTargets = new Set<string>();
  private bufferedMentionTargetsBySession = new Map<string, Set<string>>();
  private dedupTimer?: ReturnType<typeof setInterval>;
  /** Map conversationId → latest sessionWebhook URL for sending replies. */
  private webhooks: Map<string, string> = new Map();
  private activeReactionKeys = new Set<string>();
  /** sessionId → reaction keys, so a dead session's reactions can be recalled. */
  private sessionReactionKeys = new Map<
    string,
    Map<string, { messageId: string; chatId: string }>
  >();
  /**
   * Real inbound message ids (insertion-ordered, size-capped). Unlike the
   * TTL-swept seenMessages dedup map, entries survive long queue waits, so a
   * turn that starts minutes after its message arrived still gets a reaction.
   */
  private inboundMessageIds = new Set<string>();
  /**
   * Token cache for proactive sends. The stream SDK only refreshes its token
   * on (re)connect, so a long-lived socket serves a stale one after ~2h.
   */
  private proactiveToken?: { token: string; expiresAt: number };
  private robotApiToken?: { token: string; expiresAt: number };
  private readonly interactiveCardConfig: DingtalkInteractiveCardConfig;
  protected readonly interactiveCardClient?: DingtalkInteractiveCardClient;
  private statusCardController?: StatusCardController;
  private questionCardController?: QuestionCardController;
  private interactionPresenter?: DingtalkInteractionPresenter;
  private readonly inboundCardOwners = new Map<string, CardRunCorrelation>();
  private readonly cardRunBySession = new Map<string, string>();
  private readonly cardRuns = new Map<string, CardRunCorrelation>();

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: ChannelAgentBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);

    this.atSender =
      (config as unknown as Record<string, unknown>)['atSender'] === true;
    const fileInstructions =
      config.blockStreaming === 'on' ? '' : FILE_INSTRUCTIONS;
    if (!this.config.instructions) {
      this.config.instructions = [
        '## DingTalk Channel',
        '',
        'You are responding through DingTalk.',
        IMAGE_INSTRUCTIONS,
        fileInstructions,
      ].join('\n');
    } else {
      if (!this.config.instructions.includes('[IMAGE:')) {
        this.config.instructions += IMAGE_INSTRUCTIONS;
      }
      if (fileInstructions && !this.config.instructions.includes('[FILE:')) {
        this.config.instructions += fileInstructions;
      }
    }
    this.interactiveCardConfig = parseDingtalkInteractiveCardConfig(
      (config as DingtalkChannelConfig).interactiveCards,
    );

    if (!config.clientId || !config.clientSecret) {
      throw new Error(
        `Channel "${name}" requires clientId and clientSecret for DingTalk.`,
      );
    }

    const rawUseConnectionManager = (config as DingtalkChannelConfig)
      .useConnectionManager;
    if (
      rawUseConnectionManager !== undefined &&
      typeof rawUseConnectionManager !== 'boolean'
    ) {
      throw new Error(
        `Channel "${name}" useConnectionManager must be a boolean.`,
      );
    }
    const useConnectionManager = rawUseConnectionManager ?? true;

    this.client = this.createClient(useConnectionManager);
    if (this.interactiveCardConfig.enabled) {
      this.interactiveCardClient = new DingtalkInteractiveCardClient({
        robotCode: config.clientId,
        getAccessToken: () => this.getProactiveToken(),
      });
      if (
        this.interactiveCardConfig.statusCard.enabled &&
        config.blockStreaming !== 'on'
      ) {
        this.statusCardController = new StatusCardController({
          client: this.interactiveCardClient,
          cancelRun: (sessionId, runId) =>
            this.requestPromptRunCancellation(sessionId, runId),
          ...(config.model ? { model: config.model } : {}),
          onError: (operation, error) => {
            process.stderr.write(
              `[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}\n`,
            );
          },
        });
      }
      if (this.interactiveCardConfig.questionCard.enabled) {
        this.questionCardController = new QuestionCardController({
          client: this.interactiveCardClient,
          timeoutMs: this.interactiveCardConfig.questionCard.timeoutMs,
          sendFallback: (chatId, text) => this.sendMessage(chatId, text),
          reserveRunProjection: (runId) =>
            this.interactionPresenter?.reserveProjection(runId),
          onError: (operation, error) => {
            process.stderr.write(
              `[DingTalk:${this.name}] ${operation} failed: ${sanitizeLogText(String(error), 300)}\n`,
            );
          },
        });
      }
      if (this.statusCardController || this.questionCardController) {
        this.interactionPresenter = new DingtalkInteractionPresenter({
          statusCards: this.statusCardController,
          questionCards: this.questionCardController,
          ...(config.blockStreaming !== 'on'
            ? {
                sendFallback: (
                  chatId: string,
                  text: string,
                  sessionId: string,
                ) => this.sendFallbackReply(chatId, text, sessionId),
              }
            : {}),
        });
      }
    }
    if (useConnectionManager) {
      this.connectionManager = new DingtalkConnectionManager({
        initialClient: this.client,
        createClient: () => this.createClient(true),
        getSocket: (client) =>
          (client as unknown as { socket?: DingtalkManagedSocket }).socket,
        onClientChanged: (client) => {
          this.client = client;
        },
        log: (message) => {
          process.stderr.write(
            `[DingTalk:${this.name}] ${sanitizeLogText(message, 200)}\n`,
          );
        },
      });
    }
  }

  private createClient(useConnectionManager: boolean): DWClient {
    const client = new DWClient({
      clientId: this.config.clientId!,
      clientSecret: this.config.clientSecret!,
      keepAlive: !useConnectionManager,
    });
    client.config.autoReconnect = !useConnectionManager;
    this.installStructuredDownstreamHandler(client);
    this.registerMessageHandler(client);
    return client;
  }

  private installStructuredDownstreamHandler(streamClient: DWClient): void {
    const client = streamClient as DingTalkClientInternals;
    client.debug = false;
    // Keep raw SDK downstream frames off stdout; this switch mirrors the SDK
    // dispatch table and should be checked when upgrading the DingTalk SDK.
    client.onDownStream = (raw: unknown) => {
      this.onDownStream(raw, client);
    };
  }

  private registerMessageHandler(client: DWClient): void {
    client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
      client.send(msg.headers.messageId, {
        status: EventAck.SUCCESS,
        message: 'ok',
      });
      this.onMessage(msg);
    });
    if (this.interactiveCardConfig.enabled) {
      client.registerCallbackListener(TOPIC_CARD, (msg: DWClientDownStream) => {
        this.onCardCallback(client, msg);
      });
    }
  }

  private onCardCallback(client: DWClient, msg: DWClientDownStream): void {
    const callback = parseDingtalkCardCallback(msg.data);
    const actorId = callback?.actorId ?? parseDingtalkCardActorId(msg.data);
    let result: DingtalkCardCallbackResult;
    try {
      result = callback
        ? this.routeCardCallback(callback)
        : { kind: 'ignored', ...(actorId ? { actorId } : {}) };
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] card callback routing failed: ${sanitizeLogText(String(err), 200)}\n`,
      );
      result = { kind: 'ignored', ...(actorId ? { actorId } : {}) };
    }
    client.send(msg.headers.messageId, {
      status: EventAck.SUCCESS,
      message: 'ok',
    });
    if (result.kind === 'accepted') {
      void result.execute().catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] card callback action failed: ${sanitizeLogText(String(err), 200)}\n`,
        );
      });
    } else if (result.kind === 'forbidden') {
      void this.sendCardInteractionFeedback(
        result.actorId,
        result.target,
      ).catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] card interaction feedback failed: ${sanitizeLogText(String(err), 200)}\n`,
        );
      });
    }
  }

  protected routeCardCallback(
    callback: DingtalkCardCallback,
  ): DingtalkCardCallbackResult {
    if (callback.actionId === 'btn_stop') {
      return (
        this.statusCardController?.claimStop(
          callback.outTrackId,
          callback.actorId,
        ) ?? { kind: 'ignored', actorId: callback.actorId }
      );
    }
    return (
      this.questionCardController?.claim(callback) ?? {
        kind: 'ignored',
        actorId: callback.actorId,
      }
    );
  }

  private onDownStream(raw: unknown, client: DingTalkClientInternals): void {
    this.connectionManager?.noteActivity(client);
    const decoded = this.decodeDownStream(raw);
    let msg: DWClientDownStream;
    try {
      const parsed = JSON.parse(decoded.text) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        process.stderr.write(
          `[DingTalk:${this.name}] downstream parsed to non-object, ignoring.\n`,
        );
        return;
      }
      msg = parsed as DWClientDownStream;
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse downstream: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
      return;
    }
    const headers: Record<string, unknown> =
      msg.headers && typeof msg.headers === 'object' ? msg.headers : {};
    const type = typeof msg.type === 'string' ? msg.type : '';
    const topic = typeof headers['topic'] === 'string' ? headers['topic'] : '';
    const messageId =
      typeof headers['messageId'] === 'string' ? headers['messageId'] : '';

    process.stderr.write(
      `[DingTalk:${this.name}] downstream type=${sanitizeLogText(type, 40)} topic=${sanitizeLogText(
        topic,
        80,
      )} messageId=${sanitizeLogText(messageId, 80)} bytes=${decoded.bytes}\n`,
    );

    if ((type === 'CALLBACK' || type === 'EVENT') && (!topic || !messageId)) {
      process.stderr.write(
        `[DingTalk:${this.name}] Ignoring downstream with invalid routing headers.\n`,
      );
      return;
    }

    const normalizedMsg = {
      ...msg,
      headers: { ...headers, topic, messageId },
    } as DWClientDownStream;

    switch (type) {
      case 'SYSTEM':
        this.callDownStreamHandler(client, 'onSystem', normalizedMsg);
        if (topic === 'disconnect') {
          this.connectionManager?.requestReconnect(client, 'SYSTEM disconnect');
        }
        break;
      case 'EVENT':
        this.callDownStreamHandler(client, 'onEvent', normalizedMsg);
        break;
      case 'CALLBACK':
        this.callDownStreamHandler(client, 'onCallback', normalizedMsg);
        break;
      default:
        process.stderr.write(
          `[DingTalk:${this.name}] Ignoring downstream type ${sanitizeLogText(
            type || 'unknown',
            40,
          )}.\n`,
        );
    }
  }

  private callDownStreamHandler(
    client: DingTalkClientInternals,
    method: 'onSystem' | 'onEvent' | 'onCallback',
    msg: DWClientDownStream,
  ): void {
    try {
      client[method](msg);
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] ${method} failed: ${sanitizeLogText(
          String(err),
          200,
        )}\n`,
      );
    }
  }

  private decodeDownStream(raw: unknown): { text: string; bytes: number } {
    if (typeof raw === 'string') {
      return { text: raw, bytes: Buffer.byteLength(raw) };
    }
    if (Buffer.isBuffer(raw)) {
      return { text: raw.toString('utf8'), bytes: raw.length };
    }
    if (raw instanceof Uint8Array) {
      return { text: Buffer.from(raw).toString('utf8'), bytes: raw.byteLength };
    }
    if (raw instanceof ArrayBuffer) {
      return {
        text: Buffer.from(raw).toString('utf8'),
        bytes: raw.byteLength,
      };
    }
    return { text: String(raw), bytes: Buffer.byteLength(String(raw)) };
  }

  async connect(): Promise<void> {
    if (this.connectionManager) {
      await this.connectionManager.start();
    } else {
      await this.client.connect();
    }

    // Periodically clean up dedup map
    this.dedupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.seenMessages) {
        if (now - ts > DEDUP_TTL_MS) {
          this.seenMessages.delete(id);
        }
      }
    }, 60_000);

    process.stderr.write(`[DingTalk:${this.name}] Connected via stream.\n`);
  }

  /**
   * A group message with no conversationId can't be routed to a stable shared
   * session (chatId would fall back to the expiring sessionWebhook), so it is
   * dropped on ingestion. Exposed for testing the drop rule.
   */
  static isUnroutableGroupMessage(
    isGroup: boolean,
    conversationId: string | undefined,
  ): boolean {
    return isGroup && !conversationId;
  }

  private async prepareOutgoingImages(text: string): Promise<string> {
    const markers = findImageMarkers(text);
    if (markers.length === 0) return text;

    const replacements: string[] = [];
    for (const marker of markers) {
      const fileName =
        basename(marker.path)
          .replace(/[\r\n[\]]+/g, '_')
          .slice(0, 100) || 'image';
      try {
        const image = readValidatedImage(marker.path, {
          workspaceDir: this.config.cwd,
        });
        let mediaId: string | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const token = await this.getProactiveToken();
          try {
            mediaId = await uploadDingTalkImage(image, token);
            break;
          } catch (error) {
            if (
              error instanceof DingTalkMediaUploadError &&
              error.authFailure &&
              attempt === 0
            ) {
              this.proactiveToken = undefined;
              continue;
            }
            throw error;
          }
        }
        if (!mediaId) {
          throw new Error('DingTalk media upload returned no MediaID');
        }
        replacements.push(`![image](${mediaId})`);
      } catch (error) {
        process.stderr.write(
          `[DingTalk:${this.name}] outbound image upload failed (${sanitizeLogText(
            fileName,
            100,
          )}): ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        replacements.push(`[Image delivery failed: ${fileName}]`);
      }
    }

    return replaceImageMarkers(text, markers, replacements);
  }

  private async prepareOutgoingContent(
    text: string,
  ): Promise<PreparedDingTalkOutput> {
    const imageText = await this.prepareOutgoingImages(text);
    const markers = findFileMarkers(imageText);
    const files: PreparedDingTalkFile[] = [];
    let outgoingText = imageText;
    if (markers.length > 0) {
      const replacements: string[] = [];
      for (const [index, marker] of markers.entries()) {
        if (index >= MAX_FILES_PER_RESPONSE) {
          replacements.push(
            '[File delivery failed: response file limit exceeded]',
          );
          continue;
        }

        const fileName = safeFileName(marker.path);
        try {
          const file = readValidatedFile(marker.path, {
            workspaceDir: this.config.cwd,
          });
          let mediaId: string | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            const token = await this.getProactiveToken();
            try {
              mediaId = await uploadDingTalkFile(file, token);
              break;
            } catch (error) {
              if (
                error instanceof DingTalkMediaUploadError &&
                error.authFailure &&
                attempt === 0
              ) {
                this.proactiveToken = undefined;
                continue;
              }
              throw error;
            }
          }
          if (!mediaId) {
            throw new Error('DingTalk media upload returned no MediaID');
          }
          files.push({
            mediaId,
            fileName: file.fileName,
            fileType: file.fileType,
          });
          // "File sent:", not "File:" — the latter self-matches the FILE marker
          // pattern, so every display-side sanitizer deleted the receipt again on
          // its way out and a file-only response rendered an empty final card.
          replacements.push(`[File sent: ${file.fileName}]`);
        } catch (error) {
          process.stderr.write(
            `[DingTalk:${this.name}] outbound file upload failed (${sanitizeLogText(
              fileName,
              255,
            )}): ${sanitizeLogText(
              error instanceof Error ? error.message : String(error),
              300,
            )}\n`,
          );
          replacements.push(`[File delivery failed: ${fileName}]`);
        }
      }
      outgoingText = replaceFileMarkers(imageText, markers, replacements);
    }

    // R4-1: nothing else sanitizes between here and the POST —
    // `normalizeDingTalkMarkdown` only splits chunks. Every shape the finder
    // cannot deliver (a cross-line `[IMAGE:\n/path]`, a cutoff `[FILE: /path`,
    // a bracketed or spaced opening) would otherwise ship as literal text,
    // absolute path included, while the display surfaces strip the very same
    // shapes fail-closed. Run that same sanitization over the outgoing text:
    // well-formed markers are already replaced with receipts above, so only
    // undeliverable residue is touched.
    const sanitizedText = sanitizeMediaMarkersToStable(
      outgoingText,
      stripPartialImageMarker,
    );
    // R7-4: residue-only input (a cutoff landing inside a marker) sanitizes
    // to nothing. Flag that with the empty string so the delivery consumers
    // send nothing instead of an empty markdown post — which DingTalk either
    // rejects with a non-zero errcode (failing the turn over content this
    // step itself stripped) or renders as an empty bubble.
    return {
      text: files.length === 0 && !sanitizedText.trim() ? '' : sanitizedText,
      files,
    };
  }

  private async sendPreparedReply(
    chatId: string,
    text: string,
    atUserId?: string,
  ): Promise<boolean> {
    // chatId is a conversationId — resolve to the latest sessionWebhook
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      process.stderr.write(
        `[DingTalk:${this.name}] No webhook for chatId ${chatId}, cannot send.\n`,
      );
      return false;
    }

    const mentionPrefix = atUserId ? `@${atUserId}\n\n` : '';
    const chunks = normalizeDingTalkMarkdown(mentionPrefix + text);
    const title = extractTitle(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isMention = i === 0 && atUserId !== undefined;
      const body = {
        msgtype: 'markdown',
        markdown: {
          title: i === 0 ? title : `${title} (cont.)`,
          text: chunk,
        },
        ...(isMention ? { at: { atUserIds: [atUserId] } } : {}),
      };

      const resp = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (isMention && process.env['QWEN_CHANNEL_DEBUG_MENTIONS'] === '1') {
        const payload = (await resp
          .clone()
          .json()
          .catch(() => undefined)) as unknown;
        const response =
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : {};
        const value = response['errcode'] ?? response['code'];
        const code =
          typeof value === 'number' || typeof value === 'string'
            ? String(value)
            : 'unknown';
        process.stderr.write(
          `[DingTalk:${this.name}] mention delivery status=${resp.status} code=${code}\n`,
        );
      }

      if (!resp.ok) {
        const detail = sanitizeLogText(await resp.text().catch(() => ''), 300);
        process.stderr.write(
          `[DingTalk:${this.name}] sendMessage failed: HTTP ${resp.status} ${detail}\n`,
        );
        throw new Error(
          `DingTalk sendMessage failed: HTTP ${resp.status}${detail ? ` ${detail}` : ''}`,
        );
      }

      // R2-9: DingTalk answers a rejected webhook post with HTTP 200 and a
      // non-zero `errcode` (quota, revoked webhook, oversized payload). Reading
      // only `resp.ok` treats every one of those as delivered.
      const code = await readDingTalkErrorCode(resp);
      if (code !== undefined) {
        process.stderr.write(
          `[DingTalk:${this.name}] sendMessage failed: API code ${code}\n`,
        );
        throw new Error(`DingTalk sendMessage failed: API code ${code}`);
      }
    }
    return true;
  }

  /**
   * Send the text, then the files — and send the files even when the text
   * send throws part-way through.
   *
   * R1-6: `prepareOutgoingContent` uploads the files and bakes their
   * `[File sent: …]` receipts INTO the text before anything is delivered, and
   * text over `CHUNK_LIMIT` goes out as several POSTs. If a later chunk fails,
   * the receipt is already in the user's chat while the files never arrive and
   * no notice is emitted — because the per-file `[File delivery failed: …]`
   * notice lives inside the delivery path the throw skipped. ChannelBase marks
   * the delivery failed and never retries, so the chat keeps a receipt for a
   * file that does not exist.
   *
   * Running the delivery on the failure path either lands the files or emits
   * their notices. The text error is rethrown unchanged afterwards, so the
   * caller's failure accounting is untouched; a failure inside the delivery
   * itself is logged rather than allowed to replace it.
   *
   * `sendText` returning `false` is the "no webhook for this chat" answer, not
   * a failure — it keeps the pre-existing behaviour of skipping the files.
   */
  private async sendTextThenFiles(
    sendText: () => Promise<boolean | void>,
    sendFiles: () => Promise<void>,
  ): Promise<void> {
    let textError: unknown;
    let deliverFiles = true;
    try {
      deliverFiles = (await sendText()) !== false;
    } catch (error) {
      textError = error;
    }
    if (deliverFiles) {
      try {
        await sendFiles();
      } catch (deliveryError) {
        if (textError === undefined) throw deliveryError;
        process.stderr.write(
          `[DingTalk:${this.name}] file delivery after a failed text send also failed: ${sanitizeLogText(
            deliveryError instanceof Error
              ? deliveryError.message
              : String(deliveryError),
            300,
          )}\n`,
        );
      }
    }
    if (textError !== undefined) throw textError;
  }

  private async sendReply(
    chatId: string,
    text: string,
    atUserId?: string,
  ): Promise<void> {
    if (!this.webhooks.has(chatId)) {
      await this.sendPreparedReply(chatId, text, atUserId);
      return;
    }
    const prepared = await this.prepareOutgoingContent(text);
    // R7-4: residue-only input sanitizes to nothing — nothing to send.
    if (!prepared.text && prepared.files.length === 0) return;
    await this.sendTextThenFiles(
      () => this.sendPreparedReply(chatId, prepared.text, atUserId),
      () => this.sendReplyFiles(chatId, prepared.files),
    );
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendReply(chatId, text);
  }

  override supportsProactiveSend(): boolean {
    return true;
  }

  // Regular proactive paths accept only group targets; webhook tasks may use
  // DMs through the one-to-one API.
  protected override supportsProactiveTarget(target: SessionTarget): boolean {
    return (
      target.isGroup === true &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  protected override supportsProactiveDeliveryTarget(
    target: SessionTarget,
  ): boolean {
    return (
      typeof target.isGroup === 'boolean' &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  protected override supportsProactiveWebhookTarget(
    target: SessionTarget,
  ): boolean {
    return (
      typeof target.isGroup === 'boolean' &&
      target.threadId === undefined &&
      this.isStableTargetId(target.chatId)
    );
  }

  /**
   * Single-shot cold send: a failed chunk aborts the remainder (already-sent
   * chunks are not recalled) and the error surfaces in the loop's lastError.
   */
  protected override async pushProactive(
    target: SessionTarget,
    text: string,
  ): Promise<void> {
    if (!text.trim()) return;

    const prepared = await this.prepareOutgoingContent(text);
    // R7-4: residue-only input sanitizes to nothing — nothing to send.
    if (!prepared.text.trim() && prepared.files.length === 0) return;

    // R3-6: files go out BEFORE the text chunks their receipts ride. The old
    // order delivered the receipt first, and under correlated flow control
    // the file POST to the same recipient then failed while the corrective
    // notice died on the very endpoint that had just rejected the file —
    // the recipient kept a receipt for a file that never arrives with no
    // visible correction. A failed delivery now rewrites its baked receipt
    // into the failure marker before any chunk sends, so the text only ever
    // claims a delivery that happened.
    let firstError: Error | undefined;
    let outgoingText = prepared.text;
    for (const file of prepared.files) {
      try {
        await this.sendProactiveFile(target, file);
      } catch (error) {
        const deliveryError =
          error instanceof Error ? error : new Error(String(error));
        firstError ??= deliveryError;
        process.stderr.write(
          `[DingTalk:${this.name}] proactive file delivery failed (${sanitizeLogText(
            file.fileName,
            255,
          )}): ${sanitizeLogText(deliveryError.message, 300)}\n`,
        );
        outgoingText = outgoingText.replace(
          `[File sent: ${file.fileName}]`,
          `[File delivery failed: ${file.fileName}]`,
        );
        try {
          await this.sendProactiveChunk(
            target,
            'File delivery failed',
            `[File delivery failed: ${file.fileName}]`,
            'file delivery failure notice',
          );
        } catch (noticeError) {
          // The rewritten receipt in the text below is the correction that
          // survives this notice dying; the loss itself still matters when
          // the chunks fail too, so it is logged.
          process.stderr.write(
            `[DingTalk:${this.name}] proactive file failure notice not delivered: ${sanitizeLogText(
              noticeError instanceof Error
                ? noticeError.message
                : String(noticeError),
              300,
            )}\n`,
          );
        }
      }
    }

    const chunks = normalizeDingTalkMarkdown(outgoingText);
    const title = extractTitle(outgoingText);

    // R1-6 (location 1 of 3): the file loop above already ran regardless; a
    // failed chunk rethrows after it, so the caller sees the send failure.
    let chunkError: unknown;
    try {
      for (let i = 0; i < chunks.length; i++) {
        await this.sendProactiveChunk(
          target,
          i === 0 ? title : `${title} (cont.)`,
          chunks[i]!,
          `chunk ${i + 1}/${chunks.length}`,
        );
      }
    } catch (error) {
      chunkError = error;
    }

    // The chunk failure is the one the caller must see: it is what made the
    // send fail, and the file loop above has already logged and (where it
    // could) notified about its own.
    if (chunkError !== undefined) throw chunkError;
    if (firstError) throw firstError;
  }

  private async getProactiveToken(): Promise<string> {
    const cached = this.proactiveToken;
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    const url = `${TOKEN_API}?appkey=${encodeURIComponent(
      this.config.clientId!,
    )}&appsecret=${encodeURIComponent(this.config.clientSecret!)}`;
    let data: DingTalkTokenResponse;
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
      });
      data = (await resp.json()) as DingTalkTokenResponse;
    } catch {
      process.stderr.write(
        `[DingTalk:${this.name}] access token fetch failed.\n`,
      );
      throw new Error('DingTalk access token fetch failed');
    }
    if (!data.access_token) {
      const errmsg = sanitizeLogText(String(data.errmsg ?? ''), 200);
      process.stderr.write(
        `[DingTalk:${this.name}] access token request failed: gettoken errcode=${data.errcode} ${errmsg}\n`,
      );
      throw new Error(
        `DingTalk access token request failed: gettoken errcode=${data.errcode}${errmsg ? ` ${errmsg}` : ''}`,
      );
    }
    this.proactiveToken = {
      token: data.access_token,
      // Refresh a minute early so a fire mid-expiry doesn't race the TTL.
      expiresAt:
        Date.now() + Math.max(60, (data.expires_in ?? 7200) - 60) * 1000,
    };
    return data.access_token;
  }

  private async getRobotApiToken(): Promise<string> {
    const cached = this.robotApiToken;
    if (cached && Date.now() < cached.expiresAt) return cached.token;

    let response: Response;
    try {
      response = await fetch(ROBOT_TOKEN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appKey: this.config.clientId!,
          appSecret: this.config.clientSecret!,
        }),
        signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
      });
    } catch {
      throw new Error('DingTalk robot access token fetch failed');
    }

    let data: DingTalkRobotTokenResponse;
    try {
      data = (await response.json()) as DingTalkRobotTokenResponse;
    } catch {
      throw new Error(
        `DingTalk robot access token request failed: HTTP ${response.status} invalid JSON response`,
      );
    }
    if (!response.ok || !data.accessToken) {
      throw new Error(
        `DingTalk robot access token request failed: HTTP ${response.status}`,
      );
    }

    this.robotApiToken = {
      token: data.accessToken,
      expiresAt: Date.now() + Math.max(60, (data.expireIn ?? 7200) - 60) * 1000,
    };
    return data.accessToken;
  }

  private async postRobotFileMessage(
    url: string,
    body: Record<string, unknown>,
    authentication: 'robot-api' | 'session-webhook' = 'robot-api',
  ): Promise<Record<string, unknown>> {
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error('DingTalk file delivery failed: invalid endpoint');
    }
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.port !== '' ||
      !ROBOT_MESSAGE_HOSTS.has(endpoint.hostname)
    ) {
      throw new Error('DingTalk file delivery failed: untrusted endpoint');
    }

    const usesRobotApiToken = authentication === 'robot-api';
    const attempts = usesRobotApiToken ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const token = usesRobotApiToken
        ? await this.getRobotApiToken()
        : undefined;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            ...(token ? { 'x-acs-dingtalk-access-token': token } : undefined),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
        });
      } catch {
        throw new Error(
          'DingTalk file delivery failed: network request failed',
        );
      }

      if (usesRobotApiToken && response.status === 401 && attempt === 0) {
        this.robotApiToken = undefined;
        await response.body?.cancel();
        continue;
      }

      const responseText = await response.text().catch(() => '');
      if (!response.ok) {
        throw new Error(
          `DingTalk file delivery failed: HTTP ${response.status}`,
        );
      }

      // R6-1: a 2xx body carries a verdict only when it parses as a JSON
      // object. On the session webhook that is not a guarantee — the same
      // endpoint answers a successful text post with a bare `ok` on some
      // deployments, which is precisely why `readDingTalkErrorCode` treats an
      // absent/unparseable body as "no verdict" rather than a rejection.
      // Inventing a failure here shipped the file AND a `[File delivery
      // failed: …]` notice through that same lenient webhook, so the user saw
      // a contradiction and the turn was still booked successful. The
      // robot-api branch answers documented JSON, so it stays strict.
      let data: Record<string, unknown> = {};
      if (responseText.trim()) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText) as unknown;
        } catch {
          parsed = undefined;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          if (usesRobotApiToken) {
            throw new Error(
              'DingTalk file delivery failed: invalid JSON response',
            );
          }
        } else {
          data = parsed as Record<string, unknown>;
        }
      }

      for (const value of [data['errcode'], data['code']]) {
        if (value !== undefined && String(value) !== '0') {
          throw new Error(
            `DingTalk file delivery failed: API code ${sanitizeLogText(
              String(value),
              80,
            )}`,
          );
        }
      }
      return data;
    }
    throw new Error('DingTalk file delivery failed: unauthorized');
  }

  private async sendReplyFiles(
    chatId: string,
    files: readonly PreparedDingTalkFile[],
  ): Promise<void> {
    if (files.length === 0) return;
    const webhook = this.webhooks.get(chatId);
    if (!webhook) {
      // R5-1: returning here drops every prepared file silently. The card path
      // in `onResponseComplete` runs `prepareOutgoingContent` unconditionally,
      // so the uploads have already happened and the `[File sent: …]` receipts
      // are already baked into a card that `closeOutput` delivers through the
      // robot/card API — which does not need this map. A DM whose payload has
      // no `conversationId` routes as `chatId = sessionWebhook` (the map is
      // keyed on `conversationId` only), so it reaches exactly this branch and
      // the turn would resolve successfully while the chat keeps a permanent
      // receipt for a file that was never delivered. The notice itself needs
      // the same missing webhook, so there is nothing to emit: fail the send.
      throw new Error(
        `DingTalk file delivery failed with no delivered notice: ${files
          .map((file) => sanitizeLogText(file.fileName, 255))
          .join(', ')}`,
      );
    }

    // R2-9: the `[File delivery failed: …]` notice is the only correction the
    // user ever sees once the `[File sent: …]` receipt has shipped, and it goes
    // to the same webhook that just rejected the file — so it is rejected the
    // same way whenever the cause is the webhook itself (quota, revocation).
    // Logging that and resolving would record the turn as fully successful
    // while the chat keeps a receipt for a file that does not exist. Collect
    // the undelivered notices instead and fail the send once every file has had
    // its turn.
    const undeliveredNotices: string[] = [];

    for (const file of files) {
      try {
        await this.postRobotFileMessage(
          webhook,
          {
            msgtype: 'file',
            file: {
              mediaId: file.mediaId,
              fileName: file.fileName,
              fileType: file.fileType,
            },
          },
          'session-webhook',
        );
      } catch (error) {
        process.stderr.write(
          `[DingTalk:${this.name}] outbound file delivery failed (${sanitizeLogText(
            file.fileName,
            255,
          )}): ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        try {
          await this.sendPreparedReply(
            chatId,
            `[File delivery failed: ${file.fileName}]`,
          );
        } catch (noticeError) {
          process.stderr.write(
            `[DingTalk:${this.name}] file failure notice failed: ${sanitizeLogText(
              noticeError instanceof Error
                ? noticeError.message
                : String(noticeError),
              300,
            )}\n`,
          );
          undeliveredNotices.push(sanitizeLogText(file.fileName, 255));
        }
      }
    }

    if (undeliveredNotices.length > 0) {
      throw new Error(
        `DingTalk file delivery failed with no delivered notice: ${undeliveredNotices.join(', ')}`,
      );
    }
  }

  private async sendProactiveFile(
    target: SessionTarget,
    file: PreparedDingTalkFile,
  ): Promise<void> {
    const targetBody =
      target.isGroup === true
        ? { openConversationId: target.chatId }
        : { userIds: [target.chatId] };
    const data = await this.postRobotFileMessage(
      target.isGroup === true ? GROUP_MSG_API : DIRECT_MSG_API,
      {
        robotCode: this.config.clientId!,
        ...targetBody,
        msgKey: PROACTIVE_FILE_MSG_KEY,
        msgParam: JSON.stringify(file),
      },
    );

    if (
      target.isGroup === false &&
      Array.isArray(data['invalidStaffIdList']) &&
      data['invalidStaffIdList'].includes(target.chatId)
    ) {
      throw new Error(
        'DingTalk file delivery failed: invalid direct recipient',
      );
    }
    if (
      target.isGroup === false &&
      Array.isArray(data['flowControlledStaffIdList']) &&
      data['flowControlledStaffIdList'].includes(target.chatId)
    ) {
      throw new Error(
        'DingTalk file delivery failed: direct recipient rate limited',
      );
    }
    if (
      typeof data['processQueryKey'] !== 'string' ||
      !data['processQueryKey'].trim()
    ) {
      throw new Error('DingTalk file delivery failed: missing processQueryKey');
    }
  }

  private sendCardInteractionFeedback(
    actorId: string,
    target?: { chatId: string; isGroup: boolean },
  ): Promise<void> {
    if (target?.isGroup) {
      return this.sendProactiveChunk(
        {
          channelName: this.name,
          senderId: actorId,
          chatId: target.chatId,
          isGroup: true,
        },
        '卡片操作',
        '仅任务发起人可以操作这张卡片，本次操作未生效。',
        'card interaction feedback',
      );
    }
    return this.sendProactiveChunk(
      {
        channelName: this.name,
        senderId: actorId,
        chatId: actorId,
        isGroup: false,
      },
      '卡片操作',
      '你无权操作这张卡片，仅任务发起人可以提交或停止。',
      'card interaction feedback',
    );
  }

  private async sendProactiveChunk(
    target: SessionTarget,
    title: string,
    text: string,
    chunkLabel: string,
  ): Promise<void> {
    const targetKind = target.isGroup === true ? 'group' : 'dm';
    for (let attempt = 0; ; attempt++) {
      const token = await this.getProactiveToken();
      let resp: Response;
      try {
        const targetBody =
          target.isGroup === true
            ? { openConversationId: target.chatId }
            : { userIds: [target.chatId] };
        resp = await fetch(
          target.isGroup === true ? GROUP_MSG_API : DIRECT_MSG_API,
          {
            method: 'POST',
            headers: {
              'x-acs-dingtalk-access-token': token,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              robotCode: this.config.clientId!,
              ...targetBody,
              msgKey: PROACTIVE_MSG_KEY,
              msgParam: JSON.stringify({ title, text }),
            }),
            signal: AbortSignal.timeout(PROACTIVE_FETCH_TIMEOUT_MS),
          },
        );
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause;
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send error (${targetKind}, ${chunkLabel}): ${err}${cause ? ` (${cause})` : ''}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (resp.status === 401 && attempt === 0) {
        // Stale or revoked token — refresh once and retry this chunk.
        this.proactiveToken = undefined;
        await resp.body?.cancel();
        continue;
      }
      if (!resp.ok) {
        const detail = sanitizeLogText(await resp.text().catch(() => ''), 300);
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): HTTP ${resp.status} ${detail}\n`,
        );
        throw new Error(
          `DingTalk proactive send failed: HTTP ${resp.status}${detail ? ` ${detail}` : ''}`,
        );
      }
      if (target.isGroup === false) {
        let data: DingTalkDirectMessageResponse;
        try {
          data = (await resp.json()) as DingTalkDirectMessageResponse;
        } catch {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid JSON response\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: invalid JSON response',
          );
        }
        if (data.invalidStaffIdList?.includes(target.chatId)) {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): invalid direct recipient\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: invalid direct recipient',
          );
        }
        if (data.flowControlledStaffIdList?.includes(target.chatId)) {
          process.stderr.write(
            `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): direct recipient rate limited\n`,
          );
          throw new Error(
            'DingTalk proactive send failed: direct recipient rate limited',
          );
        }
        return;
      }
      // R3-6: a group send rejected with HTTP 200 still carries a non-zero
      // `code`/`errcode` verdict in the body — reading only `resp.ok` books
      // it as delivered, exactly the gap R2-9 closed for the webhook path.
      const code = await readDingTalkErrorCode(resp);
      if (code !== undefined) {
        process.stderr.write(
          `[DingTalk:${this.name}] proactive send failed (${targetKind}, ${chunkLabel}): API code ${code}\n`,
        );
        throw new Error(`DingTalk proactive send failed: API code ${code}`);
      }
      return;
    }
  }

  private getAccessToken(): string | undefined {
    return this.client.getConfig().access_token;
  }

  private async emotionApi(
    endpoint: 'reply' | 'recall',
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    const robotCode = this.config.clientId;
    if (!robotCode || !msgId || !conversationId) return;
    try {
      const token = this.config.clientSecret
        ? await this.getProactiveToken()
        : this.getAccessToken();
      if (!token) return;
      for (let attempt = 0; attempt < EMOTION_MAX_ATTEMPTS; attempt++) {
        const resp = await fetch(`${EMOTION_API}/${endpoint}`, {
          method: 'POST',
          headers: {
            'x-acs-dingtalk-access-token': token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            robotCode,
            openMsgId: msgId,
            openConversationId: conversationId,
            emotionType: 2,
            emotionName: ACK_REACTION_NAME,
            textEmotion: {
              emotionId: ACK_EMOTION_ID,
              emotionName: ACK_REACTION_NAME,
              text: ACK_REACTION_NAME,
              backgroundId: ACK_EMOTION_BG_ID,
            },
          }),
        });
        if (resp.ok) return;

        const isTransient = resp.status === 429 || resp.status >= 500;
        if (isTransient && attempt < EMOTION_MAX_ATTEMPTS - 1) {
          await resp.body?.cancel();
          await new Promise((resolve) =>
            setTimeout(resolve, EMOTION_RETRY_BASE_DELAY_MS * 2 ** attempt),
          );
          continue;
        }

        const detail = sanitizeLogText(await resp.text().catch(() => ''), 500);
        process.stderr.write(
          `[DingTalk:${this.name}] emotion/${endpoint} failed after ${attempt + 1}/${EMOTION_MAX_ATTEMPTS} attempts: ${resp.status} ${detail}\n`,
        );
        return;
      }
    } catch {
      // best-effort, don't break message flow
    }
  }

  private async attachReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('reply', msgId, conversationId);
  }

  private async recallReaction(
    msgId: string,
    conversationId: string,
  ): Promise<void> {
    await this.emotionApi('recall', msgId, conversationId);
  }

  disconnect(): void {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
    }
    this.activeReactionKeys.clear();
    this.sessionReactionKeys.clear();
    if (this.connectionManager) {
      this.connectionManager.stop();
    } else {
      this.client.disconnect();
    }
    process.stderr.write(`[DingTalk:${this.name}] Disconnected.\n`);
  }

  /** Stable API targets are conversation or user IDs, never webhook URLs. */
  private isStableTargetId(chatId: string): boolean {
    return !!chatId && !/^https?:\/\//i.test(chatId);
  }

  private reactionKey(messageId: string, conversationId: string): string {
    return `${conversationId}:${messageId}`;
  }

  private rememberInboundMessageId(msgId: string): void {
    this.inboundMessageIds.delete(msgId);
    this.inboundMessageIds.add(msgId);
    if (this.inboundMessageIds.size > 1000) {
      const oldest = this.inboundMessageIds.values().next().value;
      if (oldest !== undefined) this.inboundMessageIds.delete(oldest);
    }
  }

  private logReactionFailure(action: string, err: unknown): void {
    process.stderr.write(
      `[DingTalk:${this.name}] ${action} failed: ${err instanceof Error ? err.message : err}\n`,
    );
  }

  private startReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isStableTargetId(chatId)) return;
    // Loop lifecycle events carry the internal job id as messageId; the
    // emotion API only accepts ids of real inbound messages, so skip anything
    // we never saw arrive.
    if (!this.inboundMessageIds.has(messageId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (this.activeReactionKeys.has(key)) return;
    this.activeReactionKeys.add(key);
    if (sessionId) {
      let keys = this.sessionReactionKeys.get(sessionId);
      if (!keys) {
        keys = new Map();
        this.sessionReactionKeys.set(sessionId, keys);
      }
      keys.set(key, { messageId, chatId });
    }
    this.attachReaction(messageId, chatId)
      .then(() => {
        if (!this.activeReactionKeys.has(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('late reaction recall', err);
          });
        }
      })
      .catch((err) => {
        this.activeReactionKeys.delete(key);
        this.logReactionFailure('reaction attach', err);
      });
  }

  private stopReaction(
    chatId: string,
    messageId?: string,
    sessionId?: string,
  ): void {
    if (!messageId || !this.isStableTargetId(chatId)) return;
    const key = this.reactionKey(messageId, chatId);
    if (sessionId) {
      const keys = this.sessionReactionKeys.get(sessionId);
      if (keys) {
        keys.delete(key);
        if (keys.size === 0) this.sessionReactionKeys.delete(sessionId);
      }
    }
    if (!this.activeReactionKeys.delete(key)) return;
    this.recallReaction(messageId, chatId).catch((err) => {
      this.logReactionFailure('reaction recall', err);
    });
  }

  /** Recall reactions left behind when a session dies without terminal lifecycle events. */
  override onSessionDied(sessionId: string): void {
    const bufferedTargets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (bufferedTargets) {
      this.bufferedMentionTargetsBySession.delete(sessionId);
      for (const messageId of bufferedTargets) {
        this.bufferedMentionTargets.delete(messageId);
        this.mentionTargets.delete(messageId);
      }
    }
    this.sessionMentionTargets.delete(sessionId);
    const cardRunId = this.cardRunBySession.get(sessionId);
    if (cardRunId) {
      this.cardRunBySession.delete(sessionId);
      this.interactionPresenter?.terminalizeRun(cardRunId, 'cancelled');
      this.cardRuns.delete(cardRunId);
    }
    const keys = this.sessionReactionKeys.get(sessionId);
    if (keys) {
      this.sessionReactionKeys.delete(sessionId);
      for (const [key, { messageId, chatId }] of keys) {
        if (this.activeReactionKeys.delete(key)) {
          void this.recallReaction(messageId, chatId).catch((err) => {
            this.logReactionFailure('session-death reaction recall', err);
          });
        }
      }
    }
    super.onSessionDied(sessionId);
  }

  protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
    if (event.type === 'started') {
      this.startReaction(event.chatId, event.messageId, event.sessionId);
      const inboundOwner = event.messageId
        ? this.inboundCardOwners.get(event.messageId)
        : undefined;
      if (event.messageId) this.inboundCardOwners.delete(event.messageId);
      if (
        event.runId &&
        event.owner &&
        inboundOwner?.ownerId === event.owner.id
      ) {
        this.cardRuns.set(event.runId, inboundOwner);
        this.cardRunBySession.set(event.sessionId, event.runId);
        this.interactionPresenter?.registerRun(
          event.runId,
          event.owner.id,
          inboundOwner.target,
          event.sessionId,
          inboundOwner.sender,
        );
        this.interactionPresenter?.startStatusCard(event.runId);
      }
      return;
    }
    if (isTerminalTaskLifecycleType(event.type)) {
      if (event.messageId) this.mentionTargets.delete(event.messageId);
      this.stopReaction(event.chatId, event.messageId, event.sessionId);
      if (event.runId) {
        if (event.type === 'failed') {
          this.interactionPresenter?.terminalizeRun(
            event.runId,
            'failed',
            event.error,
          );
        } else if (event.type === 'cancelled') {
          this.interactionPresenter?.terminalizeRun(
            event.runId,
            'cancelled',
            event.reason,
          );
        } else {
          this.interactionPresenter?.terminalizeRun(event.runId, 'completed');
        }
        this.cardRuns.delete(event.runId);
        if (this.cardRunBySession.get(event.sessionId) === event.runId) {
          this.cardRunBySession.delete(event.sessionId);
        }
      }
    }
  }

  protected override onPromptBufferDropped(
    _chatId: string,
    sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.mentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
  }

  protected override onPromptBufferDrained(
    _chatId: string,
    sessionId: string,
    messageIds: string[],
  ): void {
    for (const messageId of messageIds) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
    }
    for (const messageId of messageIds.slice(0, -1)) {
      this.mentionTargets.delete(messageId);
    }
  }

  protected override onPromptBuffered(
    _chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (messageId && this.mentionTargets.has(messageId)) {
      this.bufferedMentionTargets.add(messageId);
      let targets = this.bufferedMentionTargetsBySession.get(sessionId);
      if (!targets) {
        targets = new Set();
        this.bufferedMentionTargetsBySession.set(sessionId, targets);
      }
      targets.add(messageId);
    }
  }

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    if (messageId) {
      this.bufferedMentionTargets.delete(messageId);
      this.untrackBufferedMentionTarget(sessionId, messageId);
      const atUserId = this.mentionTargets.get(messageId);
      this.mentionTargets.delete(messageId);
      if (this.atSender && atUserId) {
        this.sessionMentionTargets.set(sessionId, atUserId);
      }
    }
    this.startReaction(chatId, messageId, sessionId);
  }

  override async handleInbound(envelope: Envelope): Promise<void> {
    if (!(await this.preflightInbound(envelope))) return;

    const messageId = envelope.messageId;
    if (messageId && envelope.senderId) {
      this.inboundCardOwners.delete(messageId);
      this.inboundCardOwners.set(messageId, {
        ownerId: envelope.senderId,
        target: {
          chatId: envelope.chatId,
          isGroup: envelope.isGroup,
        },
        ...(this.atSender && envelope.isGroup
          ? {
              sender: {
                senderName: envelope.senderName,
              },
            }
          : {}),
      });
      if (this.inboundCardOwners.size > 1000) {
        const oldest = this.inboundCardOwners.keys().next().value;
        if (oldest !== undefined) this.inboundCardOwners.delete(oldest);
      }
    }
    const atUserId = (envelope as MentionTargetEnvelope)[mentionTarget];
    if (this.atSender && messageId && atUserId) {
      this.mentionTargets.set(messageId, atUserId);
    }

    await this.processInbound(envelope);
  }

  protected override async processInbound(envelope: Envelope): Promise<void> {
    const messageId = envelope.messageId;
    try {
      await super.processInbound(envelope);
    } finally {
      if (messageId && !this.bufferedMentionTargets.has(messageId)) {
        this.mentionTargets.delete(messageId);
      }
    }
  }

  private untrackBufferedMentionTarget(
    sessionId: string,
    messageId: string,
  ): void {
    const targets = this.bufferedMentionTargetsBySession.get(sessionId);
    if (!targets) return;
    targets.delete(messageId);
    if (targets.size === 0)
      this.bufferedMentionTargetsBySession.delete(sessionId);
  }

  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    this.sessionMentionTargets.delete(sessionId);
    this.stopReaction(chatId, messageId, sessionId);
  }

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
  ): Promise<void> {
    if (!this.webhooks.has(chatId)) {
      await this.sendPreparedResponse(chatId, { text, files: [] }, sessionId);
      return;
    }
    const prepared = await this.prepareOutgoingContent(text);
    await this.sendPreparedResponse(chatId, prepared, sessionId);
  }

  private async sendPreparedResponse(
    chatId: string,
    prepared: PreparedDingTalkOutput,
    sessionId: string,
  ): Promise<void> {
    // R7-4: residue-only output sanitizes to nothing — nothing to send.
    if (!prepared.text.trim() && prepared.files.length === 0) return;
    const atUserId = this.atSender
      ? this.sessionMentionTargets.get(sessionId)
      : undefined;
    if (atUserId) this.sessionMentionTargets.delete(sessionId);
    await this.sendTextThenFiles(
      () => this.sendPreparedReply(chatId, prepared.text, atUserId),
      () => this.sendReplyFiles(chatId, prepared.files),
    );
  }

  private async sendFallbackReply(
    chatId: string,
    text: string,
    sessionId: string,
  ): Promise<void> {
    // Mid-run fallbacks must not consume the prompt's mention target: the
    // final answer of the same run still needs it.
    const atUserId = this.atSender
      ? this.sessionMentionTargets.get(sessionId)
      : undefined;
    if (!this.webhooks.has(chatId)) {
      await this.sendPreparedReply(chatId, text, atUserId);
      return;
    }
    const outgoingText = await this.prepareOutgoingImages(text);
    await this.sendPreparedReply(chatId, outgoingText, atUserId);
  }

  protected override async onResponseComplete(
    chatId: string,
    text: string,
    sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): Promise<void> {
    if (segment && this.interactionPresenter) {
      const prepared = await this.prepareOutgoingContent(text);
      // R2-5: deliver BEFORE the card finalizes. `closeOutput` bakes
      // `prepared.text` — receipts included — into a card `finalize` can no
      // longer amend, so a delivery failure landing after it left a
      // permanent receipt for a file that never arrives. Delivering first
      // means a delivery that fails without a delivered notice (the
      // sendReplyFiles throw) keeps the receipts off the card entirely; a
      // failure with a delivered notice keeps the same correction the
      // reply path has always relied on.
      await this.sendReplyFiles(chatId, prepared.files);
      if (
        await this.interactionPresenter.closeOutput(
          segment.segmentId,
          prepared.text,
          'completed',
          segment,
        )
      ) {
        return;
      }
      // The files already went out above — the fallback must not resend them.
      await this.sendPreparedResponse(
        chatId,
        { ...prepared, files: [] },
        sessionId,
      );
      return;
    }
    await this.sendResponseMessage(chatId, text, sessionId);
  }

  protected override async onOutputSegmentEnd(
    chatId: string,
    sessionId: string,
    segment: ChannelOutputSegmentContext,
    reason: ChannelOutputSegmentEndReason,
  ): Promise<void> {
    if (!this.interactionPresenter) return;
    if (reason === 'response_boundary' || reason === 'input_requested') {
      await this.closeSegmentWithFiles(chatId, sessionId, segment, reason);
      return;
    }
    await this.interactionPresenter.closeOutput(
      segment.segmentId,
      '',
      reason,
      segment,
    );
  }

  /**
   * R2-13: a boundary-closed segment used to be delivered through the display
   * compositions only — they strip FILE markers with no upload, no receipt,
   * and no failure notice — so a `[FILE: …]` emitted before a tool call, plan
   * update, or permission request silently vanished, while the final segment's
   * `onResponseComplete` path uploads and delivers the same marker. Give the
   * boundary the same prepare-then-deliver treatment; a segment without
   * deliverable markers keeps the plain display-only close.
   */
  private async closeSegmentWithFiles(
    chatId: string,
    sessionId: string,
    segment: ChannelOutputSegmentContext,
    reason: ChannelOutputSegmentEndReason,
  ): Promise<void> {
    const presenter = this.interactionPresenter!;
    // R7-1: with block streaming on, every block of this segment was already
    // delivered (and its markers uploaded) through `sendResponseMessage`. The
    // constructor withholds `sendFallback` and status cards in this mode, so
    // `closeOutput` below answers false and the plain-delivery fallback would
    // re-upload and re-send the whole accumulated segment on top of the
    // streamed copy. Mirror the constructor gating: display-close only.
    if (this.config.blockStreaming === 'on') {
      await presenter.closeOutput(segment.segmentId, '', reason, segment);
      return;
    }
    const content = presenter.segmentContent(segment.segmentId);
    if (!content || findFileMarkers(content).length === 0) {
      await presenter.closeOutput(segment.segmentId, '', reason, segment);
      return;
    }
    let prepared: PreparedDingTalkOutput;
    try {
      prepared = await this.prepareOutgoingContent(content);
    } catch (error) {
      // A failed token fetch or unreadable image must not strand the
      // segment's text — deliver it display-sanitized, as before.
      process.stderr.write(
        `[DingTalk:${this.name}] boundary segment preparation failed: ${sanitizeLogText(
          error instanceof Error ? error.message : String(error),
          300,
        )}\n`,
      );
      await presenter.closeOutput(segment.segmentId, '', reason, segment);
      return;
    }
    const delivered = await presenter.closeOutput(
      segment.segmentId,
      prepared.text,
      reason,
      segment,
    );
    if (delivered) {
      await this.sendReplyFiles(chatId, prepared.files);
      return;
    }
    // R7-3: `closeOutput` answers false for BOTH "no display surface" and
    // "the run is already terminal". Pre-PR the boundary delivered nothing
    // in the terminal case; falling back unconditionally lets a segment
    // outrun a cancel/fail mid-upload. Only a live run falls back.
    if (!presenter.isRunActive(segment.runId)) return;
    await this.sendPreparedResponse(chatId, prepared, sessionId);
  }

  protected override onResponseChunk(
    _chatId: string,
    chunk: string,
    _sessionId: string,
    segment?: ChannelOutputSegmentContext,
  ): void {
    if (segment) this.interactionPresenter?.appendOutput(segment, chunk);
  }

  protected override async presentUserInputRequest(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult> {
    const run = this.cardRuns.get(context.runId);
    if (!run || run.ownerId !== context.owner.id) {
      return { kind: 'unsupported' };
    }
    if (!this.questionCardController || !this.interactionPresenter) {
      return { kind: 'unsupported' };
    }
    return this.interactionPresenter.presentInput(context);
  }

  /**
   * Extract quoted/referenced message context from a reply.
   * DingTalk provides this via text.repliedMsg (newer) or quoteMessage (legacy).
   */
  private extractQuotedContext(data: DingTalkMessageData): {
    referencedText?: string;
    isReplyToBot: boolean;
    media?: {
      downloadCode: string;
      mediaType: 'image' | 'file' | 'audio' | 'video';
      fileName?: string;
    };
  } {
    // Newer format: text.repliedMsg
    if (data.text?.isReplyMsg && data.text.repliedMsg) {
      const replied = data.text.repliedMsg;
      const isReplyToBot =
        !!data.chatbotUserId && replied.senderId === data.chatbotUserId;

      // Note: DingTalk doesn't include content for interactiveCard replies
      // (bot responses sent via webhook). Only user message quotes have text.
      const text = this.summarizeRepliedContent(replied);
      const downloadCode = replied.content?.downloadCode;
      const mediaType = this.mediaTypeFromMsgType(replied.msgType);
      return {
        referencedText: text || undefined,
        isReplyToBot,
        ...(downloadCode && mediaType
          ? {
              media: {
                downloadCode,
                mediaType,
                fileName: replied.content?.fileName,
              },
            }
          : {}),
      };
    }

    // Legacy format: quoteMessage
    if (data.quoteMessage) {
      const quote = data.quoteMessage;
      const isReplyToBot =
        !!data.chatbotUserId && quote.senderId === data.chatbotUserId;
      const text = quote.text?.content?.trim();
      return { referencedText: text || undefined, isReplyToBot };
    }

    return { isReplyToBot: false };
  }

  /**
   * Build a text summary from a repliedMsg, handling text, richText, and
   * media message types with placeholders.
   */
  private summarizeRepliedContent(replied: DingTalkRepliedMsg): string {
    const msgType = replied.msgType;
    const content = replied.content;

    // Direct text content
    if (content?.text?.trim()) {
      return content.text.trim();
    }

    // RichText: concatenate text parts, placeholder for images
    if (content?.richText && Array.isArray(content.richText)) {
      const parts: string[] = [];
      for (const part of content.richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          parts.push(part.text);
        } else if (partType === 'picture') {
          parts.push('[image]');
        } else if (partType === 'at' && part.atName) {
          parts.push(`@${part.atName}`);
        }
      }
      const summary = parts.join('').trim();
      if (summary) return summary;
    }

    // Media type placeholders
    switch (msgType) {
      case 'picture':
        return '[image]';
      case 'file':
        return `[file: ${content?.fileName || 'file'}]`;
      case 'audio':
        return '[audio]';
      case 'video':
        return '[video]';
      default:
        break;
    }

    return '';
  }

  /**
   * Map a DingTalk message type to the media type used for downloads. Shared
   * by the direct-media (`extractContent`) and quoted-media
   * (`extractQuotedContext`) paths so the mapping cannot drift between them.
   */
  private mediaTypeFromMsgType(
    msgType: string | undefined,
  ): 'image' | 'file' | 'audio' | 'video' | undefined {
    if (msgType === 'picture') return 'image';
    if (msgType === 'file' || msgType === 'audio' || msgType === 'video') {
      return msgType;
    }
    return undefined;
  }

  /**
   * Extract text and media download codes from an incoming DingTalk message.
   * Handles text, richText, picture, file, audio, and video message types.
   */
  private extractContent(data: DingTalkMessageData): {
    text: string;
    downloadCodes: string[];
    mediaType?: 'image' | 'file' | 'audio' | 'video';
    fileName?: string;
    placeholder?: string;
  } {
    const msgtype = data.msgtype || 'text';

    if (msgtype === 'richText') {
      const richText = data.content?.richText;
      if (!Array.isArray(richText)) {
        return { text: '', downloadCodes: [] };
      }
      let text = '';
      const codes: string[] = [];
      for (const part of richText) {
        const partType = part.type || 'text';
        if (partType === 'text' && part.text) {
          text += part.text;
        } else if (partType === 'picture' && part.downloadCode) {
          codes.push(part.downloadCode);
        }
      }
      return {
        text: text.trim() || (codes.length > 0 ? '(image)' : ''),
        downloadCodes: codes,
        mediaType: codes.length > 0 ? 'image' : undefined,
      };
    }

    if (msgtype === 'picture') {
      const code = data.content?.downloadCode;
      return {
        text: '(image)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
      };
    }

    if (msgtype === 'file') {
      const code = data.content?.downloadCode;
      const fileName = data.content?.fileName || undefined;
      const placeholder = `(file: ${fileName || 'file'})`;
      return {
        text: placeholder,
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        fileName,
        placeholder,
      };
    }

    if (msgtype === 'audio') {
      const code = data.content?.downloadCode;
      const recognition = data.content?.recognition;
      return {
        text: recognition || '(audio)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: recognition ? undefined : '(audio)',
      };
    }

    if (msgtype === 'video') {
      const code = data.content?.downloadCode;
      return {
        text: '(video)',
        downloadCodes: code ? [code] : [],
        mediaType: this.mediaTypeFromMsgType(msgtype),
        placeholder: '(video)',
      };
    }

    // Default: text message
    return { text: data.text?.content?.trim() || '', downloadCodes: [] };
  }

  /**
   * Download a media file and attach it to the envelope.
   * Images → base64 in envelope; files → saved to temp dir with path in text.
   *
   * `cleanPlaceholderText` is the placeholder `extractContent` generated for
   * this message's own media — `(audio)`, `(video)`, `(file: name)`. Only the
   * direct-media call site has one, and only that call may erase it: on the
   * quoted-media path `envelope.text` is the user's own reply, and a reply
   * that happens to read exactly like a placeholder must survive (a group
   * `@Bot (audio)` reaches here as exactly `(audio)` after mention removal).
   */
  private async attachMedia(
    envelope: Envelope,
    downloadCode: string,
    mediaType: 'image' | 'file' | 'audio' | 'video',
    fileName?: string,
    cleanPlaceholderText?: string,
  ): Promise<void> {
    let token: string;
    try {
      token = await this.getProactiveToken();
    } catch {
      process.stderr.write(
        `[DingTalk:${this.name}] Cannot download media: access token refresh failed.\n`,
      );
      return;
    }
    const robotCode = this.config.clientId;
    if (!robotCode) {
      process.stderr.write(
        `[DingTalk:${this.name}] Cannot download media: missing robotCode.\n`,
      );
      return;
    }

    const media = await downloadMedia(downloadCode, robotCode, token);
    if (!media) return;

    // ChannelBase fills a single imageBase64 slot from the FIRST data-only
    // image attachment and silently drops every later one, so an image
    // arriving after the slot is taken (e.g. a quoted picture alongside the
    // message's own picture) falls through to the file-backed path — the
    // `saved to:` prompt line is what keeps it reachable for the agent.
    const inlineImageSlotFree = !(envelope.attachments || []).some(
      (attachment) => attachment.type === 'image' && attachment.data,
    );

    if (mediaType === 'image' && inlineImageSlotFree) {
      const mimeType = media.mimeType.startsWith('image/')
        ? media.mimeType
        : 'image/jpeg';
      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: 'image',
          data: media.buffer.toString('base64'),
          mimeType,
        },
      ];
    } else {
      // Save the media to temp dir so the agent can read it.
      //
      // R1-2: these are synchronous throw sites — ENOSPC on a write of up to
      // 50 MB, ENAMETOOLONG from a quoted fileName over 255 bytes (`basename`
      // does not truncate), a TypeError from a truthy non-string fileName. An
      // escape rejects `processMessage`, whose catch sends the generic error
      // reply and never calls `handleInbound`; the msgId is already in
      // `seenMessages`, so DingTalk's retry is deduped and the user's prompt
      // is lost for good. Degrade the way a failed download already does:
      // skip the attachment, keep the text.
      let dir: string | undefined;
      let filePath: string;
      let safeName: string;
      try {
        dir = join(tmpdir(), 'channel-files', randomUUID());
        mkdirSync(dir, { recursive: true });
        safeName =
          basename(typeof fileName === 'string' ? fileName : '') ||
          `dingtalk_${mediaType}_${Date.now()}.${
            GENERATED_MEDIA_EXT[media.mimeType] ?? 'bin'
          }`;
        filePath = join(dir, safeName);
        writeFileSync(filePath, media.buffer);
      } catch (error) {
        // The store directory (and any partial file) is useless without the
        // attachment — remove it so failed stores do not accumulate in tmpdir.
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true });
          } catch {
            // Best effort; the degraded delivery below is the contract.
          }
        }
        process.stderr.write(
          `[DingTalk:${this.name}] Cannot store media, delivering the text without it: ${sanitizeLogText(
            error instanceof Error ? error.message : String(error),
            300,
          )}\n`,
        );
        return;
      }

      // Clean up the placeholder this message's own media produced.
      if (
        cleanPlaceholderText !== undefined &&
        envelope.text === cleanPlaceholderText
      ) {
        envelope.text = '';
      }

      envelope.attachments = [
        ...(envelope.attachments || []),
        {
          type: mediaType,
          filePath,
          mimeType: media.mimeType,
          fileName: safeName,
        },
      ];
    }
  }

  private onMessage(downstream: DWClientDownStream): void {
    try {
      const data: DingTalkMessageData =
        typeof downstream.data === 'string'
          ? JSON.parse(downstream.data)
          : (downstream.data as DingTalkMessageData);
      this.logDebugPayload('DingTalk', data);
      const dataMsgId = typeof data.msgId === 'string' ? data.msgId : undefined;
      const headerMsgId =
        typeof downstream.headers.messageId === 'string'
          ? downstream.headers.messageId
          : undefined;
      const msgId = dataMsgId || headerMsgId;

      // Dedup: DingTalk retries unACKed messages
      if (msgId && this.seenMessages.has(msgId)) {
        return;
      }
      if (msgId) {
        this.seenMessages.set(msgId, Date.now());
        this.rememberInboundMessageId(msgId);
      }

      const isGroup = data.conversationType === '2';
      const sessionWebhook =
        typeof data.sessionWebhook === 'string'
          ? data.sessionWebhook
          : undefined;
      const conversationId =
        typeof data.conversationId === 'string'
          ? data.conversationId
          : undefined;
      const conversationTitle =
        typeof data.conversationTitle === 'string'
          ? data.conversationTitle
          : undefined;
      const isMentioned = Boolean(data.isInAtList);
      const senderNick =
        typeof data.senderNick === 'string' ? data.senderNick : undefined;
      const senderStaffId =
        typeof data.senderStaffId === 'string' ? data.senderStaffId : undefined;
      const senderIdValue =
        typeof data.senderId === 'string' ? data.senderId : undefined;

      if (!sessionWebhook) {
        process.stderr.write(
          `[DingTalk:${this.name}] No sessionWebhook in message, skipping.\n`,
        );
        return;
      }

      // A group message with no conversationId can't be routed to a stable
      // session — chatId would fall back to the expiring sessionWebhook and the
      // shared-session key would churn. Drop it rather than fragment the group.
      if (DingtalkChannel.isUnroutableGroupMessage(isGroup, conversationId)) {
        // Include identifying context so an operator can tell whether one sender
        // or every group message is affected if DingTalk starts omitting
        // conversationId (API regression / edge-case message type).
        process.stderr.write(
          `[DingTalk:${this.name}] Group message has no conversationId, skipping (msgId=${
            msgId || 'unknown'
          }, sender=${sanitizeSenderName(
            senderNick || senderStaffId || 'unknown',
          )})\n`,
        );
        return;
      }

      // Cache webhook by conversationId so sendMessage can look it up
      if (conversationId) {
        this.webhooks.set(conversationId, sessionWebhook);
      }

      process.stderr.write(
        `[DingTalk:${this.name}] message msgId=${sanitizeLogText(
          msgId || 'unknown',
          80,
        )} conversationId=${sanitizeLogText(
          conversationId || '',
          120,
        )} isGroup=${isGroup} isMentioned=${isMentioned} senderNick=${sanitizeLogText(
          senderNick || '',
          80,
        )} senderStaffId=${sanitizeLogText(
          senderStaffId || '',
          80,
        )} senderId=${sanitizeLogText(senderIdValue || '', 80)}\n`,
      );

      // Extract text and media info from message
      const content = this.extractContent(data);
      let cleanText = content.text;

      // Strip first @mention (the bot) from text, keep other @mentions intact.
      // Anchor to start-of-string so @ symbols inside URLs or emails
      // (e.g. git@host:path) are not accidentally stripped (#7402).
      if (isMentioned) {
        cleanText = cleanText.replace(/^\s*@[^\s\p{Cf}]+/u, '').trim();
      }

      // Extract quoted message context
      const quoted = this.extractQuotedContext(data);

      const chatId = conversationId || sessionWebhook;

      // After stripping the bot @mention, cleanText may legitimately be empty
      // (user pinged the bot with no other text). Don't fall back to the
      // original text in that case — it would re-introduce the @mention.
      const messageText = isMentioned ? cleanText : cleanText || content.text;
      // Carry mention targets as a structured envelope field (like
      // referencedText) so ChannelBase renders the marker after prompt
      // sanitization and slash-command parsing sees the body alone.
      const mentionedMemberIds = isGroup ? collectNonBotMentionIds(data) : [];
      const senderId = senderStaffId || senderIdValue || '';
      const senderName = senderNick || senderId || 'Unknown';

      const envelope: Envelope = {
        channelName: this.name,
        senderId,
        senderName,
        chatId,
        ...(isGroup && conversationTitle
          ? { chatName: conversationTitle }
          : {}),
        text: messageText,
        ...(mentionedMemberIds.length > 0 ? { mentionedMemberIds } : {}),
        isGroup,
        isMentioned,
        isReplyToBot: quoted.isReplyToBot,
        referencedText: quoted.referencedText,
      };

      // Reactions are resolved later via the chatId passed to
      // onPromptStart/onPromptEnd — no extra bookkeeping needed.
      envelope.messageId = msgId;

      if (this.atSender && isGroup && senderStaffId) {
        (envelope as MentionTargetEnvelope)[mentionTarget] = senderStaffId;
      }

      const processMessage = async () => {
        // Download media if present (first downloadCode only for images)
        if (content.downloadCodes.length > 0 && content.mediaType) {
          await this.attachMedia(
            envelope,
            content.downloadCodes[0]!,
            content.mediaType,
            content.fileName,
            content.placeholder,
          );
        }
        if (quoted.media) {
          await this.attachMedia(
            envelope,
            quoted.media.downloadCode,
            quoted.media.mediaType,
            quoted.media.fileName,
          );
        }
        await this.handleInbound(envelope);
      };

      // Don't await — stream callback should return quickly
      processMessage().catch((err) => {
        process.stderr.write(
          `[DingTalk:${this.name}] Error handling message: ${err}\n`,
        );
        this.sendMessage(
          chatId,
          'Sorry, something went wrong processing your message.',
        ).catch(() => {});
      });
    } catch (err) {
      process.stderr.write(
        `[DingTalk:${this.name}] Failed to parse message: ${err}\n`,
      );
    }
  }
}
