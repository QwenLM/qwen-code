import type { components } from './generated/managed-agent-api';
import type { ManagedAgentRequestOptions } from './managed-agent-provider';

type Schemas = components['schemas'];

export type ManagedToolResult = Schemas['PublicToolResult'];
export type ManagedArtifact = Schemas['PublicArtifact'];
export type ManagedToolResultResponse = Schemas['ToolResultResponse'];
export type ManagedArtifactResponse = Schemas['ArtifactResponse'];
export type ManagedArtifactPage = Schemas['WebShellArtifactPage'];

export type ManagedArtifactSave = (
  artifact: ManagedArtifact,
  options: {
    signal?: AbortSignal;
    openStream: () => Promise<ReadableStream<Uint8Array>>;
  },
) => Promise<void>;

export interface ManagedToolResultReader {
  readonly canDownload: boolean;
  getResult(
    sessionId: string,
    itemId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedToolResultResponse>;
  listArtifacts(
    sessionId: string,
    options: ManagedAgentRequestOptions & { cursor?: string; limit?: number },
  ): Promise<ManagedArtifactPage>;
  getArtifact(
    sessionId: string,
    artifactId: string,
    options: ManagedAgentRequestOptions,
  ): Promise<ManagedArtifactResponse>;
  readRange(
    artifact: ManagedArtifact,
    offset: number,
    length: number,
    options: ManagedAgentRequestOptions,
  ): Promise<Uint8Array>;
  downloadArtifact(
    artifact: ManagedArtifact,
    options: ManagedAgentRequestOptions,
  ): Promise<void>;
}
