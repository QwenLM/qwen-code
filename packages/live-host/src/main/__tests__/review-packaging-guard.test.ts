import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const workflow = readFileSync(
  new URL('../../../../../.github/workflows/live-host.yml', import.meta.url),
  'utf8',
);
const entitlements = readFileSync(
  new URL('../../../build/entitlements.mac.plist', import.meta.url),
  'utf8',
);
const packaging = readFileSync(
  new URL('../../../electron-builder.yml', import.meta.url),
  'utf8',
);
const assertion = workflow.match(/\| node -e '([\s\S]*?)\n\s*'/)?.[1];
assert(assertion, 'The exact workflow entitlement assertion must be found');
const values = Object.fromEntries(
  [...entitlements.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map(
    ([, key, value]) => [key, value === 'true'],
  ),
);

function checkEntitlements(value: Record<string, boolean>) {
  return spawnSync(process.execPath, ['-e', assertion!], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
}

describe('Host camera packaging contract review regression', () => {
  it('accepts the source entitlement plist in the exact CI guard', () => {
    const result = checkEntitlements(values);
    assert.equal(result.status, 0, result.stderr);
  });

  it('still rejects an unrelated extra entitlement', () => {
    const result = checkEntitlements({
      ...values,
      'com.apple.security.device.bluetooth': true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unexpected Live Host entitlements/);
  });

  it('rejects disabled or missing camera entitlement', () => {
    const withoutCamera = { ...values };
    delete withoutCamera['com.apple.security.device.camera'];
    for (const value of [
      withoutCamera,
      { ...values, 'com.apple.security.device.camera': false },
    ]) {
      assert.equal(checkEntitlements(value).status, 1);
    }
  });

  it('does not forbid the explicitly packaged camera usage description', () => {
    assert.match(packaging, /NSCameraUsageDescription: ['"][^'"]+['"]/);
    const unused = workflow.match(/for unused_permission in ([^;]+); do/)?.[1];
    assert(unused, 'The workflow unused-permission guard must be found');
    assert.equal(
      unused.split(/\s+/).includes('NSCameraUsageDescription'),
      false,
    );
    assert.match(workflow, /Print :NSCameraUsageDescription/);
    assert.match(workflow, /\$\{camera_usage\/\/\[\[:space:\]\]\/\}/);
  });
});
