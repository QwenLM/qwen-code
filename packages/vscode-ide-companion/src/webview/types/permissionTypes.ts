export interface PermissionOption {
  name: string;
  kind: string;
  optionId: string;
}

export interface PermissionToolCall {
  title?: string;
  kind?: string;
  toolName?: string;
  toolCallId?: string;
  rawInput?: {
    command?: string;
    description?: string;
    [key: string]: unknown;
  };
  content?: Array<{
    type: string;
    [key: string]: unknown;
  }>;
  locations?: Array<{
    path: string;
    line?: number | null;
  }>;
  status?: string;
}

export interface PermissionRequestPayload {
  options: PermissionOption[];
  toolCall: PermissionToolCall;
}
