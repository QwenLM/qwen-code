import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  authorizeDaemonRequest,
  buildWebShellSessionUrl,
  denyWebShellPermissions,
  isSafeExternalUrl,
  isSameDaemonOrigin,
} from '../web-shell-security.ts';

describe('WebShell session window security', () => {
  it('places only opaque workspace and session ids in the URL', () => {
    const url = buildWebShellSessionUrl(
      'http://127.23.45.67:9527/private?token=must-not-leak',
      {
        workspaceId: 'live/workspace',
        workspaceCwd: '/private/secret/worktree',
        sessionId: 'worker/session',
      },
    );
    assert.equal(
      url,
      'http://127.23.45.67:9527/session/worker%2Fsession?workspace=live%2Fworkspace',
    );
    assert.equal(url.includes('secret'), false);
    assert.equal(url.includes('token'), false);
  });

  it('injects bearer auth only for the exact HTTP or WebSocket origin', () => {
    const origin = 'http://127.0.0.1:9527';
    assert.deepEqual(
      authorizeDaemonRequest(
        'ws://127.0.0.1:9527/events',
        origin,
        'private-token',
        { Accept: '*/*' },
      ),
      { Accept: '*/*', Authorization: 'Bearer private-token' },
    );
    assert.deepEqual(
      authorizeDaemonRequest('https://example.com/', origin, 'private-token', {
        authorization: 'Bearer private-token',
        Accept: '*/*',
      }),
      { Accept: '*/*' },
    );
    assert.equal(isSameDaemonOrigin('http://127.0.0.1:9528/', origin), false);
  });

  it('allows only web links to leave the isolated window', () => {
    assert.equal(isSafeExternalUrl('https://example.com/docs'), true);
    assert.equal(isSafeExternalUrl('file:///private/etc/passwd'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
  });

  it('denies every browser permission in opened WebShell windows', () => {
    let check: (() => boolean) | undefined;
    let request:
      | ((
          contents: unknown,
          permission: unknown,
          callback: (granted: boolean) => void,
        ) => void)
      | undefined;
    let device: (() => boolean) | undefined;
    let display:
      | ((request: unknown, callback: (streams: object) => void) => void)
      | undefined;
    denyWebShellPermissions({
      setPermissionCheckHandler: (handler) => {
        check = handler as () => boolean;
      },
      setPermissionRequestHandler: (handler) => {
        request = handler as typeof request;
      },
      setDevicePermissionHandler: (handler) => {
        device = handler as () => boolean;
      },
      setDisplayMediaRequestHandler: (handler) => {
        display = handler as typeof display;
      },
    });

    assert.equal(check?.(), false);
    assert.equal(device?.(), false);
    let permissionGranted: boolean | undefined;
    request?.(undefined, 'media', (granted) => {
      permissionGranted = granted;
    });
    assert.equal(permissionGranted, false);
    let streams: object | undefined;
    display?.(undefined, (value) => {
      streams = value;
    });
    assert.deepEqual(streams, {});
  });
});
