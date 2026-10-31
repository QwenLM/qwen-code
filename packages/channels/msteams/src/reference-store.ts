import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TeamsReferenceStore, TeamsTarget } from './types.js';

/** Atomic files for one process; shared hosts must supply their own durable store. */
export class FileTeamsReferenceStore implements TeamsReferenceStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    return join(
      this.directory,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }

  async get(key: string): Promise<TeamsTarget | undefined> {
    try {
      return JSON.parse(await readFile(this.path(key), 'utf8')) as TeamsTarget;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return undefined;
      throw error;
    }
  }

  async set(key: string, target: TeamsTarget): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(target), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
