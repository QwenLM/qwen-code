import type { Message, PermissionRequest } from '../adapters/types.js';
import type { PromptFile, PromptImage } from '../adapters/promptTypes.js';
import type { ComposerSubmitMetadata } from '../hooks/useComposerCore.js';

export type Admission = 'accepted' | 'rejected' | 'unknown';

export type Outcome = 'established' | 'unsettled' | 'failed';

export interface IntentTarget {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly attemptId?: string;
  readonly requestId?: string;
}

export interface IntentResult {
  readonly admission: Admission;
  // Absent when admission is rejected; established/failed require an
  // accepted admission, unsettled accompanies accepted or unknown.
  readonly outcome?: Outcome;
  readonly target: IntentTarget;
}

export type OperationState =
  | 'pending'
  | 'running'
  | 'established'
  | 'unsettled'
  | 'failed';

export type IntentKind =
  | 'submit'
  | 'cancel'
  | 'approval'
  | 'question'
  | 'compression'
  | 'lifecycle'
  | 'mcp';

export interface ChatOperation {
  readonly id: string;
  readonly kind: IntentKind;
  readonly state: OperationState;
  readonly target: IntentTarget;
}

export type ChatPhase =
  | 'idle'
  | 'submitting'
  | 'running'
  | 'cancelling'
  | 'failed';

export interface PendingApproval {
  readonly id: string;
  // Superseded approvals render as superseded, never as applied; they leave
  // this list only when the backend confirms the decision against the
  // still-current request.
  readonly status: 'pending' | 'superseded';
  // Render-ready request for the shared ToolApproval input. Backend-neutral
  // (the shared adapters/types model), so the surface never branches on kind.
  readonly request: PermissionRequest;
}

export interface PendingQuestion {
  readonly id: string;
  // Render-ready request for the shared AskUserQuestion input.
  readonly request: PermissionRequest;
}

export interface QuestionAnswer {
  readonly questionId: string;
  readonly value: string;
}

export interface ComposerSubmit {
  readonly text: string;
  readonly images?: readonly PromptImage[];
  readonly files?: readonly PromptFile[];
  readonly metadata?: ComposerSubmitMetadata;
}

export interface ModelSelectionController {
  readonly models: readonly { modelId: string; label: string }[];
  readonly selectedModelId?: string;
  select(modelId: string): Promise<IntentResult>;
}

export interface ApprovalSelectionController {
  readonly mode: string;
  readonly availableModes: readonly string[];
  select(mode: string): Promise<IntentResult>;
}

export interface ContextUsageController {
  readonly usageKnown: boolean;
  readonly inputTokens?: number;
  readonly contextWindowSize?: number;
  compress(): Promise<IntentResult>;
}

export type SessionLifecycleAction =
  | 'close'
  | 'archive'
  | 'unarchive'
  | 'delete';

export interface SessionOpsController {
  rename(title: string): Promise<IntentResult>;
  export?(): Promise<IntentResult>;
  lifecycle?(action: SessionLifecycleAction): Promise<IntentResult>;
}

export interface ChatCapabilities {
  readonly contextUsage: boolean;
  readonly usageStats: boolean;
  readonly modelSelection: boolean;
  readonly approvalSelection: boolean;
  readonly sessionOps: boolean;
  readonly conversationSearch: boolean;
  readonly goalDisplay: boolean;
  readonly terminal: boolean;
  readonly tasks: boolean;
  readonly diagnostics: boolean;
  readonly artifacts: boolean;
}

export interface ChatStatusFacts {
  readonly queueLength: number;
  readonly goalActive: boolean;
}

export interface SessionChatController {
  // Identity only; the surface never branches on it.
  readonly kind: 'daemon' | 'managed';
  readonly sessionId: string;
  readonly storageKey: string;

  // In-flight and recently settled intents, observable across refresh.
  // Retention is bounded: at most the latest terminal entry per kind and
  // target, readable until acknowledged. Rejected requests carry no outcome
  // and are not tracked as operations.
  readonly operations: readonly ChatOperation[];

  readonly messages: readonly Message[];
  readonly transcriptState: 'loading' | 'ready' | 'error';
  readonly hasOlderHistory?: boolean;
  readonly loadingOlderHistory?: boolean;
  readonly historyCapacityReached?: boolean;
  readonly historyPaginationError?: boolean;
  loadOlder?(options?: { force?: boolean }): Promise<void>;

  // `cancelling` is derived from an unestablished cancel operation and
  // persists until settlement evidence arrives.
  readonly phase: ChatPhase;
  submit(input: ComposerSubmit): Promise<IntentResult>;
  cancel(): Promise<IntentResult>;

  readonly pendingApprovals: readonly PendingApproval[];
  readonly pendingQuestions: readonly PendingQuestion[];
  respondApproval(id: string, optionId: string): Promise<IntentResult>;
  respondQuestion(
    id: string,
    answers: readonly QuestionAnswer[],
  ): Promise<IntentResult>;

  // A region renders only when its sub-controller is present; capability
  // flags are derived from the same facts and gate auxiliary controls.
  readonly modelSelection?: ModelSelectionController;
  readonly approvalSelection?: ApprovalSelectionController;
  readonly contextUsage?: ContextUsageController;
  readonly sessionOps?: SessionOpsController;

  readonly statusFacts: ChatStatusFacts;
  readonly capabilities: ChatCapabilities;
}
