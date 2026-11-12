import type {
  ManagedAgentCommandOptions,
  ManagedAgentRequestOptions,
} from './managed-agent-provider';
import type { components } from './generated/managed-agent-api';

export type ManagedSideQuery = components['schemas']['WebShellSideQuery'];
export type ManagedSideQueryKind = ManagedSideQuery['kind'];
export type ManagedSideQueryCreate = Omit<
  components['schemas']['WebShellSideQueryCreateRequest'],
  'sessionId' | 'idempotencyKey' | 'requestId'
>;
export type ManagedSideQueryContext =
  components['schemas']['WebShellSideQueryContext'];
export type ManagedSideQueryPage =
  components['schemas']['WebShellSideQueryPage'];

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
