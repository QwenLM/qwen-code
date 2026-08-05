import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const RELEASE_WORKFLOW = new URL(
  '../../../../../../../.github/workflows/live-host-release.yml',
  import.meta.url,
);

describe('Live Host release verification', () => {
  it('checks only top-level packaged apps', async () => {
    const workflow = await readFile(RELEASE_WORKFLOW, 'utf8');

    assert.match(
      workflow,
      /find apps\/live-host\/release -mindepth 2 -maxdepth 2 -type d -name '\*\.app' -print0/u,
    );
  });

  it('does not require an unstapled DMG to pass stapler validation', async () => {
    const workflow = await readFile(RELEASE_WORKFLOW, 'utf8');

    assert.doesNotMatch(
      workflow,
      /hdiutil verify "\$dmg"\s+xcrun stapler validate "\$dmg"/u,
    );
  });
});
