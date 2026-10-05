import type {
  DaemonCloudMemoryAction,
  DaemonCloudMemoryRequest,
  DaemonCloudMemoryResponse,
} from '@qwen-code/web-shell/daemon-react-sdk';

export type CloudMemoryRecallPreference = 'precise' | 'balanced' | 'rich';

export interface CloudMemoryItem {
  memoryId: string;
  content: string;
  score?: number;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
}

export interface CloudMemoryPage {
  memories: CloudMemoryItem[];
  nextToken?: string;
}

type Invoke = (
  request: DaemonCloudMemoryRequest,
) => Promise<DaemonCloudMemoryResponse>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud memory returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function item(value: unknown): CloudMemoryItem {
  const raw = record(value);
  if (
    typeof raw['MemoryId'] !== 'string' ||
    typeof raw['Content'] !== 'string'
  ) {
    throw new Error('Cloud memory item is missing required fields.');
  }
  return {
    memoryId: raw['MemoryId'],
    content: raw['Content'],
    ...(typeof raw['Score'] === 'number' ? { score: raw['Score'] } : {}),
    ...(typeof raw['CreatedAt'] === 'number'
      ? { createdAt: raw['CreatedAt'] }
      : {}),
    ...(typeof raw['UpdatedAt'] === 'number'
      ? { updatedAt: raw['UpdatedAt'] }
      : {}),
    ...(typeof raw['Source'] === 'string' ? { source: raw['Source'] } : {}),
  };
}

function items(value: unknown): CloudMemoryItem[] {
  if (!Array.isArray(value)) {
    throw new Error('Cloud memory response does not contain a list.');
  }
  return value.map(item);
}

async function call(
  invoke: Invoke,
  action: DaemonCloudMemoryAction,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return (await invoke({ action, params })).data;
}

export function createCloudMemoryClient(invoke: Invoke) {
  return {
    async list(nextToken?: string): Promise<CloudMemoryPage> {
      const raw = record(
        await call(invoke, 'ListMemories', {
          MaxResults: 20,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      );
      return {
        memories: items(raw['Memories']),
        ...(typeof raw['NextToken'] === 'string' && raw['NextToken']
          ? { nextToken: raw['NextToken'] }
          : {}),
      };
    },
    async search(query: string): Promise<CloudMemoryItem[]> {
      const raw = record(
        await call(invoke, 'SearchMemories', { Query: query, TopK: 20 }),
      );
      return items(raw['Memories']);
    },
    async capture(content: string, mode: 'verbatim' | 'extract') {
      const raw = record(
        await call(invoke, 'CaptureMemory', {
          Content: content,
          Mode: mode,
          Source: 'qwen-code',
        }),
      );
      const captured = items(raw['Memories']);
      if (captured.length === 0) {
        throw new Error('Cloud memory did not confirm capture.');
      }
      return captured;
    },
    async remove(memoryId: string): Promise<void> {
      const raw = record(
        await call(invoke, 'DeleteMemory', { MemoryId: memoryId }),
      );
      if (raw['Deleted'] !== true) {
        throw new Error('Cloud memory did not confirm deletion.');
      }
    },
  };
}
