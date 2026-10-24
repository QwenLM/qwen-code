import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PUBLIC_DOC_ROOTS } from '../src/app/public-docs.js';

const contentDir = 'content';

async function linkPublicDocs() {
  try {
    await rm(contentDir, { force: true, recursive: true });
    await mkdir(contentDir);
    await cp('../docs/index.md', join(contentDir, 'index.md'));
    await cp('../docs/_meta.ts', join(contentDir, '_meta.ts'));

    for (const root of PUBLIC_DOC_ROOTS) {
      const source = join('..', '..', 'docs', root);
      // Windows symlinks need Developer Mode or elevation; a junction needs
      // neither, but it must name an absolute target.
      const target = join(contentDir, root);
      if (process.platform === 'win32') {
        await symlink(resolve(contentDir, source), target, 'junction');
      } else {
        await symlink(source, target);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to link public docs into ${contentDir}: ${message}`,
    );
  }
}

await linkPublicDocs();
