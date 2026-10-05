import { describe, expect, it, vi } from 'vitest';
import { createCloudMemoryClient } from './cloud-memory';

describe('cloud memory client', () => {
  it('uses POP-compatible action payloads', async () => {
    const invoke = vi.fn().mockResolvedValue({
      data: {
        Memories: [
          {
            MemoryId: 'memory-1',
            Content: 'Prefers concise answers',
            Source: 'qwen-code',
          },
        ],
      },
    });
    const client = createCloudMemoryClient(invoke);

    await expect(client.search('answer style')).resolves.toEqual([
      {
        memoryId: 'memory-1',
        content: 'Prefers concise answers',
        source: 'qwen-code',
      },
    ]);
    expect(invoke).toHaveBeenCalledWith({
      action: 'SearchMemories',
      params: { Query: 'answer style', TopK: 20 },
    });
  });

  it('does not report an empty capture as stored', async () => {
    const invoke = vi.fn().mockResolvedValue({ data: { Memories: [] } });

    await expect(
      createCloudMemoryClient(invoke).capture('remember this', 'verbatim'),
    ).rejects.toThrow('Cloud memory did not confirm capture.');
  });
});
