import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLiveHostDiagnosticsEnabled } from '../../shared/diagnostics.ts';

describe('Live Host diagnostics', () => {
  it('supports the public Host flag and the private renderer flag', () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled(['electron', '.', '--live-debug'], {}),
      true,
    );
    assert.equal(
      isLiveHostDiagnosticsEnabled(
        ['electron-helper', '--qwen-live-debug'],
        {},
      ),
      true,
    );
  });

  it('supports the diagnostics environment variable', () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled([], { QWEN_LIVE_DIAGNOSTICS: '1' }),
      true,
    );
  });

  it("does not use Electron's reserved --debug argument", () => {
    assert.equal(
      isLiveHostDiagnosticsEnabled(['electron', '.', '--debug'], {}),
      false,
    );
  });
});
