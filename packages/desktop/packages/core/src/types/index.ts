/**
 * Re-export all types from @craft-agent/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  WorkspaceKind,
  RemoteServerConfig,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  IntermediateMessageKind,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  MessageTextElementType,
  MessageTextElement,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  AvailableSlashCommand,
  AvailableSkillDetail,
  RecoveryAction,
  TypedError,
  AskUserQuestionOption,
  AskUserQuestionItem,
  PermissionRequest,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';
