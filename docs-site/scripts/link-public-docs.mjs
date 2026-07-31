import { cp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { PUBLIC_DOC_ROOTS } from '../src/app/public-docs.js';

const contentDir = 'content';

async function linkPublicDocs() {
  try {
    await rm(contentDir, { force: true, recursive: true });
    await mkdir(contentDir);
    await cp('../docs/index.md', join(contentDir, 'index.md'));
    await cp('../docs/_meta.ts', join(contentDir, '_meta.ts'));

    for (const root of PUBLIC_DOC_ROOTS) {
      await symlink(join('..', '..', 'docs', root), join(contentDir, root));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to link public docs into ${contentDir}: ${message}`,
    );
  }
}

await linkPublicDocs();
