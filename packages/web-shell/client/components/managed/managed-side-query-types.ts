import type {
  ManagedAgentCommandOptions,
  ManagedAgentRequestOptions,
} from './managed-agent-provider';

import type {
  WebShellSideQuery,
  WebShellSideQueryContext,
  WebShellSideQueryCreateRequest,
  WebShellSideQueryPage,
} from './java-agent-contract-types';
export type ManagedSideQuery = WebShellSideQuery;
export type ManagedSideQueryKind = ManagedSideQuery['kind'];
export type ManagedSideQueryCreate = Omit<
  WebShellSideQueryCreateRequest,
  'sessionId' | 'idempotencyKey' | 'requestId'
>;
export type ManagedSideQueryContext = WebShellSideQueryContext;
export type ManagedSideQueryPage = WebShellSideQueryPage;

export interface ManagedSideQueriesProvider {
  context(
    sessionId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedSideQueryContext>;
  create(
    sessionId: string,
    request: ManagedSideQueryCreate,
    options: ManagedAgentCommandOptions,
  ): Promise<ManagedSideQuery>;
  list(
    sessionId: string,
    options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
  ): Promise<ManagedSideQueryPage>;
  get(
    sessionId: string,
    queryId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedSideQuery>;
  stream(
    sessionId: string,
    queryId: string,
    options: ManagedAgentRequestOptions & { afterRevision?: number },
  ): AsyncIterable<ManagedSideQuery>;
  cancel(
    sessionId: string,
    queryId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedSideQuery>;
}

export function isManagedSideQueryActive(query: ManagedSideQuery): boolean {
  return query.status === 'preparing' || query.status === 'running';
}
