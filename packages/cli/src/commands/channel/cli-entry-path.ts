import * as path from 'node:path';

export function findCliEntryPath(): string {
  const mainModule = process.argv[1];
  if (mainModule) {
    return path.resolve(mainModule);
  }
  throw new Error('Cannot determine CLI entry path');
}
