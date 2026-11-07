// @vitest-environment jsdom

import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import type { ComposerSubmitMetadata } from '../../hooks/useComposerCore';
import { createInputAnnotationsFromComposerTags } from '../../utils/composerTag';
import { useManagedFileReferences } from './use-managed-file-references';
import { encodeManagedInput } from './managed-input';

describe('Managed file reference snapshots', () => {
  let root: Root;
  let current: ReturnType<typeof useManagedFileReferences>;
  let provider: ManagedAgentProvider;
  let revision: string;
  const text = '\uFEFF你好\r\nexact bytes';
  function Probe({ cwd = '.', session = 'new' }) {
    current = useManagedFileReferences(
      provider,
      'client',
      {
        workspaceId: 'workspace',
        cwdRelative: cwd,
      },
      session,
    );
    return null;
  }
  async function render(cwd = '.', session = 'new') {
    await act(async () => root.render(<Probe cwd={cwd} session={session} />));
  }
  beforeEach(async () => {
    vi.stubGlobal('crypto', webcrypto);
    root = createRoot(document.createElement('div'));
    revision = 'registered-generation';
    const sha256 = Array.from(
      new Uint8Array(
        await webcrypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(text),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    provider = {
      storageKey: 'tenant:actor',
      workspaceFiles: {
        query: vi.fn(async () => ({
          scopeRevision: revision,
          directory: '.',
          entries: [{ path: 'src/a.ts', name: 'src', kind: 'directory' }],
          truncated: false,
        })),
        read: vi.fn(async (request: { path: string }) => ({
          scopeRevision: revision,
          path: request.path,
          name: 'a.ts',
          mimeType: 'text/plain',
          text,
          byteLength: new TextEncoder().encode(text).length,
          sha256,
        })),
      },
    } as unknown as ManagedAgentProvider;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  });
  async function select(path = 'src/a.ts') {
    let tag;
    await act(async () => {
      tag = await current.actions!.prepareFileReference!({
        id: `file:${path}`,
        kind: 'file',
        value: path,
        serialized: `@${path}`,
        metadata: { fileKind: 'file', filePath: path },
      });
    });
    return tag!;
  }
  async function metadata() {
    const tag = await select();
    return {
      inputAnnotations: createInputAnnotationsFromComposerTags(
        '@src/a.ts explain',
        [tag],
      ),
    } satisfies ComposerSubmitMetadata;
  }

  it('reports discarded references only in their original Workspace and clears the error on selection', async () => {
    await render();
    const actions = current.actions!;
    act(() => actions.onFileReferenceDiscarded!());
    expect(current.error).toBe('Draft changed; select the file again.');
    await select();
    expect(current.error).toBeUndefined();
    await render('other');
    act(() => actions.onFileReferenceDiscarded!());
    expect(current.error).toBeUndefined();
  });

  it('treats an unsupported file-access capability as absent actions, not an error', async () => {
    vi.mocked(provider.workspaceFiles!.query).mockRejectedValueOnce(
      Object.assign(
        new Error('Workspace file access requires an updated CLI.'),
        { status: 409, code: 'workspace_files_unsupported' },
      ),
    );
    await render();
    // The composer simply has no file actions; the refusal must not become a
    // standing alert above the editor.
    expect(current.actions).toBeUndefined();
    expect(current.error).toBeUndefined();
  });

  it('still reports a Workspace probe failure that is not a capability refusal', async () => {
    vi.mocked(provider.workspaceFiles!.query).mockRejectedValueOnce(
      Object.assign(new Error('Workspace storage is unavailable.'), {
        status: 503,
        code: 'workspace_files_busy',
      }),
    );
    await render();
    expect(current.actions).toBeUndefined();
    expect(current.error).toBe('Workspace storage is unavailable.');
  });

  it('still reports a 409 probe failure whose code is not the capability refusal', async () => {
    vi.mocked(provider.workspaceFiles!.query).mockRejectedValueOnce(
      Object.assign(new Error('Workspace file is unavailable.'), {
        status: 409,
        code: 'workspace_file_unavailable',
      }),
    );
    await render();
    // The suppression keys on the code, not the status: a fenced or draining
    // Workspace answers this same probe with 409 too, and must still surface.
    expect(current.actions).toBeUndefined();
    expect(current.error).toBe('Workspace file is unavailable.');
  });

  it('still surfaces an unsupported refusal after the mount probe succeeded', async () => {
    await render();
    vi.mocked(provider.workspaceFiles!.read).mockRejectedValueOnce(
      Object.assign(
        new Error('Workspace file access requires an updated CLI.'),
        { status: 409, code: 'workspace_files_unsupported' },
      ),
    );
    await act(async () => {
      await expect(
        current.actions!.prepareFileReference!({
          id: 'file:src/a.ts',
          kind: 'file',
          value: 'src/a.ts',
          serialized: '@src/a.ts',
          metadata: { fileKind: 'file', filePath: 'src/a.ts' },
        }),
      ).rejects.toThrow('Workspace file access requires an updated CLI.');
    });
    // The same code can mean the broker failed mid-request, so only the mount
    // probe may treat it as an absent capability.
    expect(current.error).toBe(
      'Workspace file access requires an updated CLI.',
    );
  });

  it('stores exact contents in the chip, survives JSON draft persistence and submits without rereading', async () => {
    await render();
    const saved = JSON.parse(
      JSON.stringify(await metadata()),
    ) as ComposerSubmitMetadata;
    const prepared = await current.prepareInput('@src/a.ts explain', [], saved);
    expect(provider.workspaceFiles!.read).toHaveBeenCalledTimes(1);
    expect(prepared.files).toEqual([
      { name: 'a.ts', media_type: 'text/plain', text },
    ]);
    expect(prepared.text).toContain('src/a.ts');
    expect(
      (await encodeManagedInput(prepared.text, [], prepared.files)).at(-1),
    ).toEqual({
      type: 'input_file',
      name: 'a.ts',
      mime_type: 'text/plain',
      text,
    });
  });

  it('rechecks authorization/generation but never fetches new bytes at submit time', async () => {
    await render();
    const selected = await metadata();
    revision = 'new-generation';
    await expect(
      current.prepareInput('@src/a.ts explain', [], selected),
    ).rejects.toThrow('Workspace changed');
    expect(provider.workspaceFiles!.read).toHaveBeenCalledTimes(1);
  });

  it('requires reselection after directory changes and rejects corrupted stored snapshots', async () => {
    await render();
    const selected = await metadata();
    await render('other');
    await expect(
      current.prepareInput('@src/a.ts explain', [], selected),
    ).rejects.toThrow('select the file again');
    await render();
    const corrupted = JSON.parse(
      JSON.stringify(selected).replace('exact bytes', 'changed bytes'),
    ) as ComposerSubmitMetadata;
    await expect(
      current.prepareInput('@src/a.ts explain', [], corrupted),
    ).rejects.toThrow('snapshot is invalid');
  });

  it('keeps ordinary typed paths as text and disambiguates duplicate attachment basenames', async () => {
    await render();
    expect(await current.prepareInput('@secret.ts explain')).toEqual({
      text: '@secret.ts explain',
      files: [],
    });
    expect(provider.workspaceFiles!.read).not.toHaveBeenCalled();
    const prepared = await current.prepareInput(
      '@src/a.ts explain',
      [{ name: 'a.ts', media_type: 'text/plain', text: 'upload' }],
      await metadata(),
    );
    expect(prepared.files.map((file) => file.name)).toEqual([
      'a.ts',
      'reference-1-a.ts',
    ]);
    expect(prepared.text).toContain('"src/a.ts" → "reference-1-a.ts"');
  });

  it('applies the 8 MiB encoded input bound to referenced files', async () => {
    await render();
    const prepared = await current.prepareInput(
      'prompt '.repeat(8000) + '@src/a.ts',
      [],
      {
        inputAnnotations: createInputAnnotationsFromComposerTags('@src/a.ts', [
          await select(),
        ]),
      },
    );
    await expect(
      encodeManagedInput(prepared.text, [], prepared.files),
    ).resolves.toHaveLength(2);
    await expect(
      encodeManagedInput(
        prepared.text,
        [],
        [
          ...prepared.files,
          {
            name: 'large.txt',
            media_type: 'text/plain',
            text: 'x'.repeat(8 * 1024 * 1024),
          },
        ],
      ),
    ).rejects.toThrow('8 MiB');
  });

  it('rejects a snapshot from another Session even with an identical Workspace context', async () => {
    await render('.', 'session-a');
    const selected = await metadata();
    await render('.', 'session-b');
    await expect(
      current.prepareInput('@src/a.ts explain', [], selected),
    ).rejects.toThrow('select the file again');
  });

  it('resolves an existing Session from its ID for query, read and upload', async () => {
    const api = enableUploads();
    await render('.qwen-managed-worktrees/owned/src', 'session-a');
    expect(api.query).toHaveBeenLastCalledWith(
      { sessionId: 'session-a', directory: '.', query: '' },
      { clientId: 'client', signal: expect.any(AbortSignal) },
    );
    await select();
    expect(api.read).toHaveBeenLastCalledWith(
      {
        sessionId: 'session-a',
        path: 'src/a.ts',
        expectedScopeRevision: revision,
      },
      { clientId: 'client' },
    );
    const data = new Blob(['session upload']);
    await current.uploadTarget!.client.uploadWorkspaceFile({
      path: 'file.txt',
      data,
    });
    expect(api.upload).toHaveBeenLastCalledWith(
      {
        sessionId: 'session-a',
        path: 'file.txt',
        expectedScopeRevision: revision,
        uploadId: expect.any(String),
      },
      data,
      { clientId: 'client', signal: undefined },
    );
    const prepared = await current.prepareInput(
      '@src/a.ts explain',
      [],
      await metadata(),
    );
    expect(prepared.files[0]?.text).toBe(text);
    expect(api.query).toHaveBeenLastCalledWith(
      { sessionId: 'session-a', directory: '.', query: '' },
      { clientId: 'client' },
    );
  });

  it('blocks submission until every selected file has finished loading', async () => {
    const read = provider.workspaceFiles!.read;
    const original = vi.mocked(read).getMockImplementation()!;
    const snapshot = await original(
      {
        workspaceId: 'workspace',
        cwdRelative: '.',
        path: 'src/a.ts',
        expectedScopeRevision: revision,
      },
      { clientId: 'client' },
    );
    let finish!: (value: typeof snapshot) => void;
    vi.mocked(read).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    let selected!: Promise<import('../../customization').WebShellComposerTag>;
    await act(async () => {
      selected = current.actions!.prepareFileReference!({
        id: 'file',
        kind: 'file',
        value: 'src/a.ts',
        serialized: '@src/a.ts',
        metadata: { fileKind: 'file', filePath: 'src/a.ts' },
      });
    });
    expect(current.busy).toBe(true);
    await expect(current.prepareInput('send now')).rejects.toThrow(
      'finish loading',
    );
    let tag!: Awaited<typeof selected>;
    await act(async () => {
      finish(snapshot);
      tag = await selected;
    });
    expect(current.busy).toBe(false);
    const prepared = await current.prepareInput('@src/a.ts', [], {
      inputAnnotations: createInputAnnotationsFromComposerTags('@src/a.ts', [
        tag,
      ]),
    });
    expect(prepared.files).toEqual([
      { name: 'a.ts', media_type: 'text/plain', text },
    ]);
  });

  it('rejects a Workspace change while snapshot hashing is still in flight', async () => {
    await render();
    const selected = await metadata();
    let release!: (value: ArrayBuffer) => void;
    const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn(
          () =>
            new Promise<ArrayBuffer>((resolve) => {
              release = resolve;
            }),
        ),
      },
    });
    const preparing = current
      .prepareInput('@src/a.ts explain', [], selected)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await act(async () => {
      await Promise.resolve();
    });
    await render('other');
    release(await digest('SHA-256', new TextEncoder().encode(text)));
    expect(await preparing).toBeInstanceOf(Error);
    expect(((await preparing) as Error).message).toContain('Workspace changed');
  });

  it('guards the caller after later attachment encoding awaits', async () => {
    await render();
    const captured = current;
    const prepared = await captured.prepareInput(
      '@src/a.ts explain',
      [],
      await metadata(),
    );
    await render('other');
    await encodeManagedInput(prepared.text, [], prepared.files);
    expect(() => captured.assertCurrent()).toThrow('Workspace changed');
  });

  it('keeps disambiguated long basenames inside the attachment name limit', async () => {
    const name = `${'a'.repeat(252)}.ts`;
    const read = provider.workspaceFiles!.read;
    const original = vi.mocked(read).getMockImplementation()!;
    vi.mocked(read).mockImplementationOnce(async (request, options) => ({
      ...(await original(request, options)),
      name,
    }));
    await render();
    const tag = await select(`src/${name}`);
    const prompt = tag.serialized!;
    const prepared = await current.prepareInput(
      prompt,
      [{ name, media_type: 'text/plain', text: 'upload' }],
      {
        inputAnnotations: createInputAnnotationsFromComposerTags(prompt, [tag]),
      },
    );
    expect(prepared.files[1]!.name.length).toBeLessThanOrEqual(255);
    await expect(
      encodeManagedInput(prepared.text, [], prepared.files),
    ).resolves.toHaveLength(3);
  });

  function enableUploads() {
    const api = provider.workspaceFiles!;
    const original = vi.mocked(api.query).getMockImplementation()!;
    vi.mocked(api.query).mockImplementation(async (request, options) => ({
      ...(await original(request, options)),
      maxUploadBytes: 8 * 1024 * 1024,
    }));
    api.upload = vi.fn(async (request, data) => ({
      scopeRevision: revision,
      uploadId: request.uploadId,
      path: request.path,
      sizeBytes: data.size,
      sha256: 'a'.repeat(64),
    }));
    api.queryUpload = vi.fn();
    return api;
  }

  it('keeps upload disabled on a read-only CLI even when the provider has an upload method', async () => {
    const api = provider.workspaceFiles!;
    api.upload = vi.fn();
    await render();
    expect(current.actions).toBeDefined();
    expect(current.uploadTarget).toBeUndefined();
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('uploads binary bytes and sends a scoped path without reading a text snapshot', async () => {
    const api = enableUploads();
    await render();
    const target = current.uploadTarget!;
    const data = new Blob([new Uint8Array([0, 255, 128, 1])]);
    const result = await target.client.uploadWorkspaceFile({
      path: '报告.pdf',
      data,
    });
    expect(api.upload).toHaveBeenCalledWith(
      {
        workspaceId: 'workspace',
        cwdRelative: '.',
        path: '报告.pdf',
        expectedScopeRevision: revision,
        uploadId: expect.any(String),
      },
      data,
      { clientId: 'client', signal: undefined },
    );
    const tag = target.createReference(result.path);
    const prompt = `${tag.serialized} inspect`;
    const prepared = await current.prepareInput(prompt, [], {
      inputAnnotations: createInputAnnotationsFromComposerTags(prompt, [tag]),
    });
    expect(prepared.text).toContain('paths relative to the working directory');
    expect(prepared.text).toContain('"报告.pdf"');
    expect(prepared.files).toEqual([]);
    expect(api.read).not.toHaveBeenCalled();
  });

  it('does not admit an upload completion or restored reference into a different Session', async () => {
    const api = enableUploads();
    await render();
    const target = current.uploadTarget!;
    const result = await target.client.uploadWorkspaceFile({
      path: 'binary.pdf',
      data: new Blob(['pdf']),
    });
    const tag = target.createReference(result.path);
    const original = vi.mocked(api.upload!).getMockImplementation()!;
    let finish!: () => void;
    vi.mocked(api.upload!).mockImplementationOnce(
      (request, data, options) =>
        new Promise((resolve) => {
          finish = () => void original(request, data, options).then(resolve);
        }),
    );
    const pending = target.client
      .uploadWorkspaceFile({
        path: 'pending.pdf',
        data: new Blob(['pdf']),
      })
      .catch((error: unknown) => error);
    await render('.', 'different-session');
    finish();
    expect(await pending).toBeInstanceOf(Error);
    expect(((await pending) as Error).message).toContain('Workspace changed');
    await expect(
      current.prepareInput('@binary.pdf', [], {
        inputAnnotations: createInputAnnotationsFromComposerTags(
          '@binary.pdf',
          [tag],
        ),
      }),
    ).rejects.toThrow('Workspace changed');
  });

  it('reconciles a lost upload response by its original ID without sending the mutation again', async () => {
    const api = enableUploads();
    await render();
    vi.mocked(api.upload!).mockRejectedValueOnce(
      new TypeError('Connection lost'),
    );
    vi.mocked(api.queryUpload!).mockImplementation(async (uploadId) => ({
      scopeRevision: revision,
      uploadId,
      state: 'completed',
      path: 'a.bin',
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    }));
    await expect(
      current.uploadTarget!.client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Blob(['a']),
      }),
    ).resolves.toMatchObject({ path: 'a.bin' });
    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.queryUpload).toHaveBeenCalledWith(
      vi.mocked(api.upload!).mock.calls[0][0].uploadId,
      { clientId: 'client', signal: undefined },
    );
  });

  it('never treats an occupied destination as an uploaded reference', async () => {
    const api = enableUploads();
    await render();
    vi.mocked(api.upload!).mockRejectedValueOnce(
      Object.assign(new Error('The file already exists.'), { status: 409 }),
    );
    await expect(
      current.uploadTarget!.client.uploadWorkspaceFile({
        path: 'a.bin',
        data: new Blob(['a']),
      }),
    ).rejects.toThrow('already exists');
    expect(api.queryUpload).not.toHaveBeenCalled();
    expect(() => current.uploadTarget!.createReference('a.bin')).toThrow(
      'has not completed',
    );
  });
});
