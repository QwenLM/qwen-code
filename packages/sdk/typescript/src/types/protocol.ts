/**
 * Protocol types for SDK-CLI communication
 *
 * Re-exports protocol types from CLI package to ensure SDK and CLI use identical types.
 */

export type {
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  ToolResultBlock,
  CLIUserMessage,
  CLIAssistantMessage,
  CLISystemMessage,
  CLIResultMessage,
  CLIPartialAssistantMessage,
  CLIMessage,
  PermissionMode,
  PermissionSuggestion,
  PermissionApproval,
  HookRegistration,
  CLIControlInterruptRequest,
  CLIControlPermissionRequest,
  CLIControlInitializeRequest,
  CLIControlSetPermissionModeRequest,
  CLIHookCallbackRequest,
  CLIControlMcpMessageRequest,
  CLIControlSetModelRequest,
  CLIControlMcpStatusRequest,
  CLIControlSupportedCommandsRequest,
  ControlRequestPayload,
  CLIControlRequest,
  ControlResponse,
  ControlErrorResponse,
  CLIControlResponse,
  ControlCancelRequest,
  ControlMessage,
} from '@qwen-code/qwen-code/protocol';

export {
  isCLIUserMessage,
  isCLIAssistantMessage,
  isCLISystemMessage,
  isCLIResultMessage,
  isCLIPartialAssistantMessage,
  isControlRequest,
  isControlResponse,
  isControlCancel,
} from '@qwen-code/qwen-code/protocol';
