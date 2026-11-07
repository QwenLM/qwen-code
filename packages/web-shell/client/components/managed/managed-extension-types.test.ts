import { expect, it } from 'vitest';
import { managedExtensionSelection } from './managed-extension-types';

const first = {
  extensionId: 'ext_00000000-0000-4000-8000-000000000001',
  packageRevision: 1,
  packageDigest: 'a'.repeat(64),
  settingsRevision: 1,
};
const other = {
  ...first,
  extensionId: 'ext_00000000-0000-4000-8000-000000000002',
};
const bindings = [first, other].map((pin) => ({
  serverId: `${pin.extensionId}:tools`,
  credentialId: `credential-${pin.extensionId}`,
  credentialGeneration: 1,
}));
const snapshot = {
  revision: 3,
  selectionVersion: 2 as const,
  extensions: [first, other],
  mcpAuthBindings: bindings,
};

it.each([
  { ...first, packageRevision: 2, packageDigest: 'b'.repeat(64) },
  { ...first, settingsRevision: 2 },
])(
  'does not carry a personal binding to a replaced pin while preserving an unrelated package',
  (replacement) => {
    expect(managedExtensionSelection(snapshot, [replacement, other])).toEqual({
      expectedConfigRevision: 3,
      selectionVersion: 2,
      extensions: [replacement, other],
      mcpAuthBindings: [bindings[1]],
    });
    expect(
      managedExtensionSelection(snapshot, [first, other]).mcpAuthBindings,
    ).toEqual(bindings);
  },
);

it('keeps the v2 protocol when removing all personal packages', () => {
  expect(managedExtensionSelection(snapshot, [])).toEqual({
    expectedConfigRevision: 3,
    selectionVersion: 2,
    extensions: [],
    mcpAuthBindings: [],
  });
});
