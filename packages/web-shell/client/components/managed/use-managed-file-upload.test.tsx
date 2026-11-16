// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useManagedFileUpload } from './use-managed-file-upload';
import type { ManagedAgentProvider } from './managed-agent-provider';

describe('useManagedFileUpload', () => {
  it('mints an upload id without crypto.randomUUID (non-secure context)', async () => {
    const upload = vi.fn(
      async (request: { uploadId: string; path: string }, data: Blob) => ({
        uploadId: request.uploadId,
        path: request.path,
        sizeBytes: data.size,
        scopeRevision: 'rev-1',
        sha256: 'a'.repeat(64),
      }),
    );
    const provider = {
      workspaceFiles: { upload },
    } as unknown as ManagedAgentProvider;
    const { result, unmount } = renderHook(() =>
      useManagedFileUpload(provider, 'client-1', {
        sessionId: 'session-1',
        source: 'workspace',
        scopeRevision: 'rev-1',
        maxUploadBytes: 1024 * 1024,
      }),
    );
    const cryptoObject = globalThis.crypto;
    const descriptor = Object.getOwnPropertyDescriptor(
      cryptoObject,
      'randomUUID',
    );
    Object.defineProperty(cryptoObject, 'randomUUID', {
      value: undefined,
      configurable: true,
    });
    try {
      expect(result.current).toBeDefined();
      const uploaded = await result.current!.client.uploadWorkspaceFile({
        path: 'notes.txt',
        data: new Uint8Array([1, 2, 3]),
      });
      expect(upload).toHaveBeenCalledTimes(1);
      expect(upload.mock.calls[0]![0].uploadId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(uploaded).toMatchObject({
        kind: 'file_upload',
        path: 'notes.txt',
        sizeBytes: 3,
      });
    } finally {
      if (descriptor) {
        Object.defineProperty(cryptoObject, 'randomUUID', descriptor);
      } else {
        delete (cryptoObject as { randomUUID?: unknown }).randomUUID;
      }
      unmount();
    }
  });
});
