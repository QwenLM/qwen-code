// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseShareEndpoint,
  parseShareResponseUrl,
  publishHtmlArtifact,
  readShareTarget,
  storeShareTarget,
} from './shareArtifact';

function workspaceActionsReturning(html: string) {
  return {
    stat: vi.fn().mockResolvedValue({
      sizeBytes: html.length,
      modifiedMs: 1,
    }),
    readFileBytes: vi.fn().mockResolvedValue({
      contentBase64: btoa(html),
      offset: 0,
      returnedBytes: html.length,
      sizeBytes: html.length,
    }),
  };
}

describe('parseShareEndpoint', () => {
  it('accepts https endpoints', () => {
    expect(parseShareEndpoint('  https://share.example.com/publish  ')).toBe(
      'https://share.example.com/publish',
    );
  });

  it('accepts plain http only on loopback hosts', () => {
    expect(parseShareEndpoint('http://localhost:8787/publish')).toBe(
      'http://localhost:8787/publish',
    );
    expect(parseShareEndpoint('http://127.0.0.1:8787/publish')).toBe(
      'http://127.0.0.1:8787/publish',
    );
    expect(parseShareEndpoint('http://[::1]:8787/publish')).toBe(
      'http://[::1]:8787/publish',
    );
  });

  it('rejects plain http to a remote host', () => {
    expect(parseShareEndpoint('http://share.example.com/publish')).toBe(
      undefined,
    );
  });

  it('rejects non-http schemes and unparseable input', () => {
    expect(parseShareEndpoint('javascript:alert(1)')).toBe(undefined);
    expect(parseShareEndpoint('file:///etc/passwd')).toBe(undefined);
    expect(parseShareEndpoint('share.example.com')).toBe(undefined);
    expect(parseShareEndpoint('')).toBe(undefined);
  });
});

describe('parseShareResponseUrl', () => {
  it('reads the url field from a JSON body', () => {
    expect(
      parseShareResponseUrl('{"url":"https://share.example.com/s/abc"}'),
    ).toBe('https://share.example.com/s/abc');
  });

  it('rejects bodies that are not usable share URLs', () => {
    expect(parseShareResponseUrl('not json')).toBe(undefined);
    expect(parseShareResponseUrl('{"link":"https://example.com"}')).toBe(
      undefined,
    );
    expect(parseShareResponseUrl('{"url":42}')).toBe(undefined);
    expect(parseShareResponseUrl('{"url":"javascript:alert(1)"}')).toBe(
      undefined,
    );
    expect(parseShareResponseUrl('null')).toBe(undefined);
  });
});

describe('share target storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips an endpoint and token', () => {
    storeShareTarget({
      endpoint: 'https://share.example.com/publish',
      token: 's3cret',
    });

    expect(readShareTarget()).toEqual({
      endpoint: 'https://share.example.com/publish',
      token: 's3cret',
    });
  });

  it('drops a previously stored token when saved without one', () => {
    storeShareTarget({
      endpoint: 'https://share.example.com/publish',
      token: 's3cret',
    });
    storeShareTarget({ endpoint: 'https://share.example.com/publish' });

    expect(readShareTarget()).toEqual({
      endpoint: 'https://share.example.com/publish',
    });
  });

  it('ignores an endpoint that is no longer acceptable', () => {
    window.localStorage.setItem(
      'qwen-web-shell-share-endpoint',
      'http://share.example.com/publish',
    );

    expect(readShareTarget()).toBe(undefined);
  });

  it('reports no target when nothing is configured', () => {
    expect(readShareTarget()).toBe(undefined);
  });
});

describe('publishHtmlArtifact', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the artifact and returns the reported URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"url":"https://share.example.com/s/abc"}', {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const url = await publishHtmlArtifact(
      workspaceActionsReturning('<h1>report</h1>'),
      'out/report.html',
      { endpoint: 'https://share.example.com/publish', token: 's3cret' },
    );

    expect(url).toBe('https://share.example.com/s/abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchMock.mock.calls[0];
    expect(endpoint).toBe('https://share.example.com/publish');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('<h1>report</h1>');
    expect(init.headers).toMatchObject({
      'content-type': 'text/html; charset=utf-8',
      authorization: 'Bearer s3cret',
    });
  });

  it('omits the authorization header when no token is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"url":"https://share.example.com/s/abc"}', {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await publishHtmlArtifact(
      workspaceActionsReturning('<h1>report</h1>'),
      'out/report.html',
      { endpoint: 'https://share.example.com/publish' },
    );

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      'authorization',
    );
  });

  it('surfaces a rejected upload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 401 })),
    );

    await expect(
      publishHtmlArtifact(
        workspaceActionsReturning('<h1>report</h1>'),
        'out/report.html',
        { endpoint: 'https://share.example.com/publish' },
      ),
    ).rejects.toThrow('401');
  });

  it('rejects a response that carries no usable URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"url":"javascript:alert(1)"}')),
    );

    await expect(
      publishHtmlArtifact(
        workspaceActionsReturning('<h1>report</h1>'),
        'out/report.html',
        { endpoint: 'https://share.example.com/publish' },
      ),
    ).rejects.toThrow('did not return a usable URL');
  });

  it('refuses to upload an artifact past the size limit', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const actions = {
      stat: vi.fn().mockResolvedValue({
        sizeBytes: 5 * 1024 * 1024 + 1,
        modifiedMs: 1,
      }),
      readFileBytes: vi.fn(),
    };

    await expect(
      publishHtmlArtifact(actions, 'out/report.html', {
        endpoint: 'https://share.example.com/publish',
      }),
    ).rejects.toThrow('too large');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
