import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withChannelPidfileLock } from './pidfile-lock.js';

describe('withChannelPidfileLock', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires and releases the real synchronous proper-lockfile adapter', () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-channel-pid-lock-'),
    );
    tempDirs.push(tempDir);
    const pidfile = path.join(tempDir, 'channels', 'service.pid');

    expect(withChannelPidfileLock(pidfile, () => 'locked')).toBe('locked');
    expect(fs.existsSync(`${pidfile}.lock`)).toBe(false);
  });
});
