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

// One remote name, two spellings: NFC and NFD are the same name to a
// user and render the same in the picker, so they must land in the same
// collision group — otherwise neither row gets marked and the confusable
// the fold exists to surface walks through. The decomposed spelling
// never offers the composed code point to the table's direct branch, so
// its parts decide the class and the generator has to resolve every
// prototype in that same space.
describe('remoteNameSkeleton canonical equivalence', () => {
  it('folds a precomposed char and its decomposed spelling alike in a name', () => {
    // `ņ` is a table key; `n` + U+0326 is not, and U+0326 is not in the
    // table either — the composed spelling used to answer `ɲ` while the
    // decomposed one answered `n̦`, so `infra` spelled either way sat in
    // two groups and neither was marked.
    expect(remoteNameSkeleton('i\u0146fra')).toBe(
      remoteNameSkeleton('in\u0326fra'),
    );
  });

  it('gives a canonical part its table chance before flattening it', () => {
    // U+1E9B decomposes canonically to `ſ` + U+0307 but compatibly to
    // `s` + U+0307: one NFKD step would flatten the `ſ` to `s` before
    // the table could answer `f` for it, and the two spellings would
    // land in ṡ and ḟ respectively.
    expect(remoteNameSkeleton('\u1E9B')).toBe(
      remoteNameSkeleton('\u017F\u0307'),
    );
  });

  it('is invariant under NFD for every canonically decomposable code point', () => {
    // Swept, not sampled: whether an entry splits depends on whether its
    // own parts are table keys, so a sample cannot know what it is
    // missing. The sweep size is asserted alongside the split list — a
    // sweep that silently visits nothing proves nothing.
    const splits: string[] = [];
    let swept = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      const nfd = ch.normalize('NFD');
      if (nfd === ch) continue;
      swept++;
      if (
        remoteNameSkeleton(nfd) !== remoteNameSkeleton(ch) &&
        splits.length < 20
      ) {
        splits.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(swept).toBeGreaterThan(13_000);
    expect(splits).toEqual([]);
  });
});

// The table's own defense of the lunate sigma, pinned: the direct branch
// has to answer before any normalization, or Ϲ routes through Σ into a
// different class and the entry Unicode carries for exactly that pair is
// dead weight.
describe('remoteNameSkeleton lunate sigma', () => {
  it('keeps Ϲ in the C class and out of the Σ class', () => {
    expect(remoteNameSkeleton('\u03F9')).toBe(remoteNameSkeleton('C'));
    expect(remoteNameSkeleton('\u03F9')).not.toBe(remoteNameSkeleton('\u03A3'));
  });
});

// The NFKC compatibility fallback for table-ABSENT chars, pinned: U+00B9
// SUPERSCRIPT ONE carries no table entry, so only the fallback can route
// it to the class of its compatibility decomposition ('1' → 'l').
describe('remoteNameSkeleton NFKC fallback', () => {
  it('folds a table-absent compatibility char through its decomposition', () => {
    expect(remoteNameSkeleton('¹')).toBe(remoteNameSkeleton('1'));
  });
});

// The skeleton keeps the table's case: case-INSENSITIVITY lives one level
// up, in the picker's collision-group key (a casefolded skeleton), because
// casefolding inside the fold would let `Ö` casefold to `ö` and re-hit the
// table mid-pass, splitting the very classes the generator closes.
describe('remoteNameSkeleton case sensitivity', () => {
  it('keeps the case-sensitive table hit in the skeleton', () => {
    expect(remoteNameSkeleton('0rigin')).toBe('Origin');
    expect(remoteNameSkeleton('0rigin')).not.toBe(remoteNameSkeleton('origin'));
    expect(remoteNameSkeleton('Istanbul')).toBe('lstanbul');
  });
});
