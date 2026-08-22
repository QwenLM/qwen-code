import { describe, expect, it, mock } from 'bun:test';
import { copyResponseText } from '../copy-response';

describe('copyResponseText', () => {
  it('writes the complete response and reports success', async () => {
    const writeText = mock(async () => {});

    await expect(
      copyResponseText('complete response', writeText),
    ).resolves.toEqual({ status: 'copied' });
    expect(writeText).toHaveBeenCalledWith('complete response');
  });

  it('reports clipboard failures', async () => {
    const writeText = mock(async () => {
      throw new Error('permission denied');
    });

    await expect(
      copyResponseText('response', writeText),
    ).resolves.toMatchObject({
      status: 'failed',
      error: expect.any(Error),
    });
  });
});
