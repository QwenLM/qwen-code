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
// the fold exists to surface walks through. The entrance NFC recomposes
// canonical spellings, so both offer the same code points to the table,
// and the generator resolves every prototype under that same runtime
// fold.
describe('remoteNameSkeleton canonical equivalence', () => {
  it('folds a precomposed char and its decomposed spelling alike in a name', () => {
    // `ņ`'s canonical decomposition is `n` + U+0327: the entrance NFC
    // recomposes it, so both spellings offer the composed code point to
    // the table. (The comma-below spelling U+0326 is a DIFFERENT name
    // and folds differently; the old parts-based table value used to
    // blur that distinction. The narrowing is the correct side of a
    // real trade: six formerly-unified ink classes — `ņ`/`n̦` among
    // them — now sit in separate skeletons, so near-identical names of
    // that shape go unmarked; over-merging is the safe direction for a
    // homoglyph marker, but the canonical-equivalence splits the old
    // fold produced — 21 of the 4853 key+mark combinations whose NFC
    // and NFD spellings differ (every table key × U+0300–U+036F),
    // comparing the fold of the NFC spelling against the fold of the
    // NFD spelling; zero under the new fold — were the larger defect,
    // and the new fold closes all of them with zero regressions in
    // that corpus.)
    expect(remoteNameSkeleton('i\u0146fra')).toBe(
      remoteNameSkeleton('in\u0327fra'),
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

  it('is invariant under canonical equivalence for multi-code-point names', () => {
    // A mark arriving inside a precomposed char's prototype stays
    // glued to its base in a positional walk, while canonical ordering
    // moves it first in a decomposed spelling — the closing NFC then
    // recomposes different stacks and the pair splits collision
    // groups. Entrance NFC closes the class; each pair below split
    // before it.
    for (const name of ['Ȧ\u309A', 'İ\u0652', 'Ő\u05B9']) {
      expect(remoteNameSkeleton(name)).toBe(
        remoteNameSkeleton(name.normalize('NFD')),
      );
    }
  });

  it('keeps the table first for a composed base fused with a mark', () => {
    // Entrance NFC fuses ö + U+0304 into U+022B, which is not a table
    // key; the longest-decomposed-prefix rule still offers the ö unit
    // to the table, so the pair shares the prototype-script group.
    expect(remoteNameSkeleton('\u00F6\u0304')).toBe(
      remoteNameSkeleton('\u0629\u0304'),
    );
  });

  it('is invariant under NFD for table bases plus swept combining marks', () => {
    // The single-code-point sweep cannot see a split that needs a mark
    // to land inside a precomposed char's prototype: build two-code-
    // point names from a table base plus a swept mark.
    const marks = [
      0x0300, 0x0301, 0x0303, 0x0304, 0x0305, 0x0307, 0x0327, 0x05ae, 0x05b4,
      0x064b, 0x064e, 0x309a,
    ];
    const bases = ['Ȧ', 'İ', 'Ő', 'o', 'A', 'n'];
    const splits: string[] = [];
    let swept = 0;
    for (const base of bases) {
      for (const mark of marks) {
        const name = base + String.fromCodePoint(mark);
        swept++;
        if (
          remoteNameSkeleton(name) !==
            remoteNameSkeleton(name.normalize('NFD')) &&
          splits.length < 10
        ) {
          splits.push(name);
        }
      }
    }
    expect(swept).toBeGreaterThan(60);
    expect(splits).toEqual([]);
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
