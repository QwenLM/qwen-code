import type { ConversationReference } from '@microsoft/agents-activity';
import type {
  ChannelBaseOptions,
  ChannelConfig,
  Envelope,
} from '@qwen-code/channel-base';

export interface TeamsCredentials {
  appId: string;
  appPassword: string;
  tenantId: string;
}

export interface TeamsConfig extends ChannelConfig, TeamsCredentials {
  webhookPort?: number;
  webhookPath?: string;
}

export interface TeamsTarget {
  readonly chatId: string;
  readonly threadId?: string;
  readonly reference: ConversationReference;
}

export interface TeamsInboundEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly activityId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly envelope: Readonly<Envelope>;
  readonly target: TeamsTarget;
}

export interface TeamsReferenceStore {
  get(key: string): Promise<TeamsTarget | undefined>;
  set(key: string, target: TeamsTarget): Promise<void>;
}

export interface TeamsSendContext {
  readonly event?: TeamsInboundEvent;
  readonly target: TeamsTarget;
  readonly kind: 'response' | 'system';
  readonly text: string;
  readonly fullText: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
}

export type TeamsSendReceipt = TeamsSendContext &
  (
    | { readonly state: 'sent'; readonly platformMessageId: string }
    | { readonly state: 'known_failed' | 'unknown' }
  );

export type TeamsPromptOutcome =
  | { readonly status: 'completed'; readonly resultText: string }
  | { readonly status: 'failed'; readonly error: unknown };

export interface TeamsHost {
  /** Persist or consume the verified event before resolving. Never wait for a prompt. */
  acceptInbound(event: TeamsInboundEvent): Promise<void>;
  /** Await authorization and durable submitting state immediately before bridge.prompt. */
  beforePrompt(event: TeamsInboundEvent, sessionId: string): Promise<void>;
  /** Bridge completion, separate from platform delivery. Never replay an uncertain submission. */
  onPromptSettled(
    event: TeamsInboundEvent,
    sessionId: string,
    outcome: TeamsPromptOutcome,
  ): Promise<void>;
  /** Revalidate authorization and persist send intent. Throw to prevent this send. */
  beforeSend(context: TeamsSendContext): Promise<void>;
  /** Persist the actual receipt before resolving. A failure leaves delivery unknown. */
  onSendReceipt(receipt: TeamsSendReceipt): Promise<void>;
}

export interface TeamsChannelOptions extends ChannelBaseOptions {
  /** Supplying a host disables the plugin-owned HTTP listener. */
  host?: TeamsHost;
  referenceStore?: TeamsReferenceStore;
}

export interface TeamsWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface TeamsWebhookResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface TeamsIngress {
  handleWebhook(input: TeamsWebhookRequest): Promise<TeamsWebhookResponse>;
}
