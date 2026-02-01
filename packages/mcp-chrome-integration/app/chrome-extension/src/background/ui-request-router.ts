export const MIGRATION_NOTICE =
  '⚠️ **Migration Notice**\n\nThe Qwen Code architecture has been upgraded to MCP (Model Context Protocol).\n\nPlease use the **Qwen CLI** to interact with the agent:\n\n`$ qwen`\n\nThis SidePanel now serves as a status and tool visualization dashboard.';

const UI_REQUEST_TYPES = new Set([
  'GET_STATUS',
  'CONNECT',
  'sendMessage',
  'cancelStreaming',
]);

export function isUiRequest(request) {
  return !!request && typeof request.type === 'string' && UI_REQUEST_TYPES.has(request.type);
}

export async function routeUiRequest(request, deps) {
  const { connect, getStatus } = deps || {};

  switch (request.type) {
    case 'GET_STATUS': {
      const nativeStatus = (getStatus && getStatus()) || { connected: false };
      const connected = !!nativeStatus.connected;
      return {
        handled: true,
        response: {
          status: connected ? 'connected' : 'disconnected',
          connected,
          permissions: [],
        },
        action: null,
      };
    }
    case 'CONNECT': {
      let connected = false;
      if (connect) {
        connected = await connect();
      }
      return {
        handled: true,
        response: {
          success: !!connected,
          connected: !!connected,
          status: connected ? 'connected' : 'disconnected',
        },
        action: null,
      };
    }
    case 'sendMessage':
      return {
        handled: true,
        response: { success: true },
        action: 'sendMigrationNotice',
      };
    case 'cancelStreaming':
      return {
        handled: true,
        response: { success: true, cancelled: true },
        action: 'cancelStreaming',
      };
    default:
      return { handled: false, response: null, action: null };
  }
}
