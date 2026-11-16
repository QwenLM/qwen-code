import type { components } from './generated/managed-agent-api';

import type { WebShellMcpManagementSubmit } from './java-agent-contract-types';
type Schemas = components['schemas'];

export type ManagedMcpServerPin = Schemas['ManagedMcpServerPin'];
export type ManagedMcpManagementSnapshot =
  Schemas['ManagedMcpManagementSnapshot'];
export type ManagedMcpManagementOperation =
  Schemas['ManagedMcpManagementOperation'];
export type ManagedMcpManagementAction =
  ManagedMcpManagementOperation['action'];
export type ManagedMcpManagementCommand = Omit<
  WebShellMcpManagementSubmit,
  'sessionId' | 'requestId' | 'idempotencyKey'
>;
