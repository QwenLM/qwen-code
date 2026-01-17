/**
 * Re-export agent types from shared package for backward compatibility.
 * All types are now defined in packages/shared/src/agent-types.ts to ensure
 * consistency between native-server and chrome-extension.
 */
export {
  type AgentRole,
  type AgentMessage,
  type StreamTransport,
  type AgentStatusEvent,
  type AgentConnectedEvent,
  type AgentHeartbeatEvent,
  type RealtimeEvent,
  type AgentAttachment,
  type AgentCliPreference,
  type AgentActRequest,
  type AgentActResponse,
  type AgentProject,
  type AgentEngineInfo,
  type AgentStoredMessage,
} from 'chrome-mcp-shared';
