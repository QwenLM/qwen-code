import { describe, expect, it } from 'vitest';
import { CONFUSABLE_PROTOTYPES } from './unicodeConfusables';
import { remoteNameSkeleton } from './remote-name-skeleton';

// Integrity gate for the committed table: a hand-edit or a stale
// regeneration that breaks any of these re-opens the skeleton splits
// the generator's closures exist to close — a value that is not a
// fixed point of the runtime fold puts one ink-identical class into
// two skeletons, and a value carrying a table key makes the fold
// order-dependent (the first substitution wins over the deeper one).
describe('unicodeConfusables table integrity', () => {
  it('holds no self-maps and no value containing a table key', () => {
    for (const [key, value] of CONFUSABLE_PROTOTYPES) {
      expect(value).not.toBe(key);
      for (const ch of value) {
        expect(CONFUSABLE_PROTOTYPES.has(ch)).toBe(false);
      }
    }
  });

  it('folds every key to its value and every value to itself', () => {
    for (const [key, value] of CONFUSABLE_PROTOTYPES) {
      expect(remoteNameSkeleton(key)).toBe(value);
      expect(remoteNameSkeleton(value)).toBe(value);
    }
  });

  it('stores every value in NFC', () => {
    for (const [, value] of CONFUSABLE_PROTOTYPES) {
      expect(value.normalize('NFC')).toBe(value);
    }
  });
});
