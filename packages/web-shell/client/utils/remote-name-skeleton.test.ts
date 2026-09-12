import { describe, expect, it } from 'vitest';
import { CONFUSABLE_PROTOTYPES } from './unicodeConfusables';
import { remoteNameSkeleton } from './remote-name-skeleton';

// Behavioral corners of the fold that the table-integrity gate cannot
// see (it only exercises table entries, which are fixed points by
// construction): the closing NFC can compose a table key, and a
// decomposed spelling only meets the table after composition — both
// split ink-identical names unless the pass iterates to a fixed point.
describe('remoteNameSkeleton closure', () => {
  it('folds an NFC-composed table key into the same class as its composed form', () => {
    // `0` maps to `O` per the table, then the closing NFC composes
    // `O` + U+030B into Ő (a table key whose prototype is Ö); Ő
    // itself folds on to Ö. One pass would strand `0̋` in group Ő.
    expect(remoteNameSkeleton('0\u030B')).toBe(remoteNameSkeleton('\u0150'));
  });

  it('folds a decomposed spelling into the same class as its precomposed twin', () => {
    // `o` + U+0308 only meets the table after NFC composes it to ö,
    // whose prototype is ة — the precomposed twin must land there too.
    expect(remoteNameSkeleton('o\u0308')).toBe(remoteNameSkeleton('\u00F6'));
  });

  it('is idempotent over every table key and value', () => {
    for (const [key, value] of CONFUSABLE_PROTOTYPES) {
      expect(remoteNameSkeleton(remoteNameSkeleton(key))).toBe(
        remoteNameSkeleton(key),
      );
      expect(remoteNameSkeleton(remoteNameSkeleton(value))).toBe(
        remoteNameSkeleton(value),
      );
    }
  });
});
