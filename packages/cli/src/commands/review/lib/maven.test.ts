/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  declaredModulesOf,
  readMavenLayout,
  mavenModuleFor,
  modulesInheritingFrom,
  affectedMavenModules,
} from './maven.js';

describe('declaredModulesOf', () => {
  it('reads the module entries in order', () => {
    const pom =
      '<project><modules><module>common</module>' +
      '<module>libs/dqc-all</module></modules></project>';
    expect(declaredModulesOf(pom)).toEqual({
      dirs: ['common', 'libs/dqc-all'],
      unmodeled: false,
    });
  });

  it('normalizes ./ prefixes, trailing slashes, and backslashes', () => {
    const pom =
      '<modules><module>./a</module><module>b/</module>' +
      '<module>c\\d</module></modules>';
    expect(declaredModulesOf(pom).dirs).toEqual(['a', 'b', 'c/d']);
  });

  it('normalizes interior ./ segments too', () => {
    const pom = '<modules><module>./x/./y//</module></modules>';
    expect(declaredModulesOf(pom).dirs).toEqual(['x/y']);
  });

  it('flags entries that point outside the basedir instead of dropping them', () => {
    // A silent drop would map files under such a module to nothing and report
    // a false green; the flag hands the repo to the fallback instead.
    const pom =
      '<modules><module>../outside</module><module>/abs</module></modules>';
    expect(declaredModulesOf(pom)).toEqual({ dirs: [], unmodeled: true });
  });

  it('flags an empty module element', () => {
    const pom = '<modules><module> </module></modules>';
    expect(declaredModulesOf(pom)).toEqual({ dirs: [], unmodeled: true });
  });

  it('flags a segment outside the shell-safe charset — the dirs reach a shell unquoted', () => {
    // A PR-controlled pom must not be able to inject through `mvn -pl <dirs>`.
    for (const entry of ['x$(reboot)', 'a b', 'semi;colon', 'tick`cmd`']) {
      const pom = `<modules><module>${entry}</module></modules>`;
      expect(declaredModulesOf(pom)).toEqual({ dirs: [], unmodeled: true });
    }
  });

  it('flags an entry the capture regex cannot see, keeping the visible ones', () => {
    // An attribute, CDATA content, or a spaced closing tag never matches the
    // capture loop; without the raw-token count the module would be silently
    // invisible and a diff inside it would map to nothing — a false green.
    for (const pom of [
      '<modules><module>ok</module><module xml:space="preserve">hidden</module></modules>',
      '<modules><module>ok</module><module><![CDATA[hidden]]></module></modules>',
      '<modules><module>ok</module><module>hidden</module ></modules>',
    ]) {
      expect(declaredModulesOf(pom)).toEqual({
        dirs: ['ok'],
        unmodeled: true,
      });
    }
  });

  it('does not count the <modules> container as a module token', () => {
    const pom = '<modules><module>a</module></modules>';
    expect(declaredModulesOf(pom)).toEqual({ dirs: ['a'], unmodeled: false });
  });

  it('ignores a <module> outside any <modules> block — plugin configuration', () => {
    // Plugin `<configuration>`s use bare `<module>` elements (a JPMS module
    // list); they are not reactor entries, and capturing one would name a
    // directory that is not a module.
    const pom =
      '<project><modules><module>real</module></modules>' +
      '<build><plugins><plugin><configuration>' +
      '<module>java.sql</module></configuration></plugin></plugins></build>' +
      '</project>';
    expect(declaredModulesOf(pom)).toEqual({
      dirs: ['real'],
      unmodeled: false,
    });
  });

  it('flags a <modules> opener the block regex cannot see', () => {
    // An attribute on `<modules>` hides every entry inside it; files under
    // those modules would map to nothing and report a false green, so flag
    // instead of guessing.
    const pom = '<modules xml:space="preserve"><module>a</module></modules>';
    expect(declaredModulesOf(pom)).toEqual({ dirs: [], unmodeled: true });
  });

  it('picks up profile-declared modules too — they hold code a diff can touch', () => {
    const pom =
      '<project><profiles><profile><id>x</id><modules>' +
      '<module>extra</module></modules></profile></profiles></project>';
    expect(declaredModulesOf(pom).dirs).toEqual(['extra']);
  });

  it('ignores commented-out modules', () => {
    // A commented-out entry whose directory does not exist would otherwise
    // flag the whole layout unmodeled and lose the scoping entirely.
    const pom =
      '<modules><!-- <module>ghost</module> --><module>real</module></modules>';
    expect(declaredModulesOf(pom)).toEqual({
      dirs: ['real'],
      unmodeled: false,
    });
  });

  it('tolerates whitespace inside the element', () => {
    const pom = '<modules><module>\n  spaced\n</module></modules>';
    expect(declaredModulesOf(pom).dirs).toEqual(['spaced']);
  });

  it('flags content the comment-strip cannot trust — CDATA or `<!--` in an attribute', () => {
    // `<!--` inside CDATA or an attribute value is NOT an XML comment, but
    // the strip matches it as one; a strip spanning a real `</modules>`
    // physically deletes entries, and every recount then runs on the
    // corrupted string — hidden modules would vanish with `unmodeled: false`.
    for (const pom of [
      '<foo><![CDATA[ x <!-- y ]]></foo><modules><module>a</module></modules>' +
        '<bar><![CDATA[ z --> w ]]></bar>',
      '<bar a="<!--"><modules><module>a</module></modules></bar>',
      "<bar b='<!--'><modules><module>a</module></modules></bar>",
    ]) {
      expect(declaredModulesOf(pom).unmodeled).toBe(true);
    }
  });

  it('treats a self-closing <modules/> as an empty block, not a hidden one', () => {
    // A placeholder `<modules/>` declares zero modules; the opener recount
    // must not read it as a block the capture regex missed (which would flag
    // a valid single-module pom unmodeled and lose the deterministic build).
    for (const pom of [
      '<project><modules/></project>',
      '<project><modules /></project>',
    ]) {
      expect(declaredModulesOf(pom)).toEqual({ dirs: [], unmodeled: false });
    }
  });

  it('strips comments over the WHOLE pom before block extraction and recount', () => {
    // A `</modules>` inside a comment must not terminate the lazy block
    // match — module `b` would vanish from capture and raw-token recount
    // alike, a false green for diffs under it.
    expect(
      declaredModulesOf(
        '<modules><module>a</module><!-- </modules> -->' +
          '<module>b</module></modules>',
      ),
    ).toEqual({ dirs: ['a', 'b'], unmodeled: false });
    // A commented-out block outside any real one must not count as a phantom
    // `<modules` opener (a false `unmodeled`).
    expect(
      declaredModulesOf(
        '<!-- <modules><module>ghost</module></modules> -->' +
          '<modules><module>real</module></modules>',
      ),
    ).toEqual({ dirs: ['real'], unmodeled: false });
  });
});

describe('readMavenLayout', () => {
  let root: string;

  const pom = (dir: string, body: string): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'pom.xml'), body);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mvn-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds nested modules — the walker recurses into each module pom', () => {
    pom(
      '',
      '<modules><module>common</module><module>libs/dqc-all</module></modules>',
    );
    pom('common', '<project/>');
    pom('libs/dqc-all', '<modules><module>dqc-core</module></modules>');
    pom('libs/dqc-all/dqc-core', '<project/>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(false);
    expect(layout.modules).toEqual([
      'common',
      'libs/dqc-all',
      'libs/dqc-all/dqc-core',
    ]);
  });

  it('flags a declared module dir with no pom.xml — files under it would map to nothing', () => {
    pom('', '<modules><module>common</module><module>ghost</module></modules>');
    pom('common', '<project/>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(true);
    expect(layout.modules).toEqual(['common']);
  });

  it('flags an outside-the-basedir entry instead of guessing about it', () => {
    pom('', '<modules><module>../sibling</module></modules>');
    expect(readMavenLayout(root).unmodeled).toBe(true);
  });

  it('ignores a module declared twice — no double-listing, no loop', () => {
    // A true cycle would need a `..` entry, which flags unmodeled first; the
    // seen set guards the duplicate-declaration shape that reaches the walk.
    pom('', '<modules><module>a</module><module>a</module></modules>');
    pom('a', '<project/>');
    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(false);
    expect(layout.modules).toEqual(['a']);
  });

  it('flags a UTF-16 nested pom instead of silently dropping its subtree', () => {
    // UTF-16 (legal to Maven via BOM; PowerShell's default encoding) decodes
    // to NUL-riddled text under utf8 that the regexes read as "declares no
    // modules" — the agg/core subtree would vanish with `unmodeled: false`,
    // and `-pl agg -am` would never put agg/core in the reactor.
    pom('', '<modules><module>agg</module></modules>');
    mkdirSync(join(root, 'agg'), { recursive: true });
    writeFileSync(
      join(root, 'agg', 'pom.xml'),
      Buffer.from('\uFEFF<modules><module>core</module></modules>', 'utf16le'),
    );
    pom('agg/core', '<project/>');

    expect(readMavenLayout(root).unmodeled).toBe(true);
  });

  it('strips a UTF-8 BOM and parses normally', () => {
    writeFileSync(
      join(root, 'pom.xml'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('<modules><module>common</module></modules>', 'utf8'),
      ]),
    );
    pom('common', '<project/>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(false);
    expect(layout.modules).toEqual(['common']);
  });

  it('propagates a bad-entries flag from a NESTED pom, not just the root', () => {
    // A nested aggregator declaring an outside-the-basedir module used to be
    // flaggable only if the malformation sat at the root; the flag must
    // propagate from every depth.
    pom('', '<modules><module>agg</module></modules>');
    pom('agg', '<modules><module>../outside</module></modules>');
    expect(readMavenLayout(root).unmodeled).toBe(true);
  });

  it('degrades to unmodeled on a moditect-shaped <modules> in plugin config — deliberately', () => {
    // The block regex cannot tell a plugin-configuration `<modules>` wrapper
    // from the real reactor block; the captured fake dirs do not exist, so
    // the layout hands off rather than scope over a model it cannot verify.
    pom(
      '',
      '<project><modules><module>real</module></modules>' +
        '<build><plugins><plugin><artifactId>moditect-maven-plugin</artifactId>' +
        '<configuration><modules><module>java.sql</module></modules>' +
        '</configuration></plugin></plugins></build></project>',
    );
    pom('real', '<project/>');

    expect(readMavenLayout(root).unmodeled).toBe(true);
  });

  it('walks a clean chain to the depth cap without flagging', () => {
    // The cap exists to bound malformed poms, not to clip real reactors: a
    // clean chain at exactly MAX_MODULE_DEPTH must stay modeled.
    let prev = '';
    for (let i = 0; i < 10; i++) {
      const name = `m${i}`;
      pom(prev, `<modules><module>${name}</module></modules>`);
      prev = prev ? `${prev}/${name}` : name;
    }
    pom(prev, '<project/>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(false);
    expect(layout.modules).toHaveLength(10);
    expect(layout.modules).toContain('m0/m1/m2/m3/m4/m5/m6/m7/m8/m9');
  });

  it("records each module's parent dir — relativePath resolved, default applied", () => {
    pom(
      '',
      '<modules><module>parent</module><module>app</module>' +
        '<module>agg</module><module>standalone</module></modules>',
    );
    pom('parent', '<project/>');
    pom(
      'app',
      '<project><parent><groupId>g</groupId><artifactId>parent</artifactId>' +
        '<relativePath>../parent</relativePath></parent></project>',
    );
    // No <relativePath> element: Maven's default is ../pom.xml — the ROOT.
    pom(
      'agg',
      '<project><parent><artifactId>root</artifactId></parent></project>',
    );
    // An explicitly empty <relativePath/> means "resolve from the repository,
    // not the tree" — no local edge.
    pom('standalone', '<project><parent><relativePath/></parent></project>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(false);
    expect(layout.parentOf.get('app')).toBe('parent');
    expect(layout.parentOf.get('agg')).toBe('');
    expect(layout.parentOf.get('standalone')).toBeNull();
  });

  it('flags unmodeled when the nesting outruns the depth cap — never a silent drop', () => {
    // A chain deeper than MAX_MODULE_DEPTH: dropping the excess silently
    // would map files in the deep modules to nothing and report a false
    // green, so the cap must flag instead.
    let prev = '';
    for (let i = 0; i < 12; i++) {
      const dir = prev ? `${prev}/m${i}` : 'm0';
      pom(prev, `<modules><module>${prev ? `m${i}` : 'm0'}</module></modules>`);
      prev = dir;
    }
    pom(prev, '<project/>');

    const layout = readMavenLayout(root);
    expect(layout.unmodeled).toBe(true);
    // The shallow end of the chain is still discovered.
    expect(layout.modules).toContain('m0');
  });
});

describe('modulesInheritingFrom', () => {
  let root: string;

  const pom = (dir: string, body: string): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'pom.xml'), body);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mvn-inh-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('widens along direct and transitive inheritance edges', () => {
    // `app` inherits ../parent; `app-impl` inherits ../app — a change to
    // parent/pom.xml reaches BOTH through the inheritance chain, and `-pl`
    // on parent alone would build neither.
    pom(
      '',
      '<modules><module>parent</module><module>app</module>' +
        '<module>app-impl</module></modules>',
    );
    pom('parent', '<project/>');
    pom(
      'app',
      '<project><parent><relativePath>../parent</relativePath></parent></project>',
    );
    pom(
      'app-impl',
      '<project><parent><relativePath>../app</relativePath></parent></project>',
    );

    const layout = readMavenLayout(root);
    expect(modulesInheritingFrom(layout, 'parent')).toEqual([
      'app',
      'app-impl',
    ]);
    expect(modulesInheritingFrom(layout, 'app')).toEqual(['app-impl']);
    expect(modulesInheritingFrom(layout, 'app-impl')).toEqual([]);
  });
});

describe('mavenModuleFor', () => {
  const modules = [
    'common',
    'libs/dqc',
    'libs/dqc-all',
    'libs/dqc-all/dqc-core',
  ];

  it('maps a file to the DEEPEST module that owns it', () => {
    expect(mavenModuleFor('libs/dqc-all/dqc-core/src/Main.java', modules)).toBe(
      'libs/dqc-all/dqc-core',
    );
    expect(mavenModuleFor('common/pom.xml', modules)).toBe('common');
  });

  it('respects the path-segment boundary between sibling prefixes', () => {
    // `libs/dqc` is a string prefix of `libs/dqc-all/...` but not its parent.
    expect(mavenModuleFor('libs/dqc-all/src/X.java', modules)).toBe(
      'libs/dqc-all',
    );
    expect(mavenModuleFor('libs/dqc/src/Y.java', modules)).toBe('libs/dqc');
  });

  it('returns null for a file under no module', () => {
    expect(mavenModuleFor('README.md', modules)).toBeNull();
    expect(mavenModuleFor('docs/x.md', modules)).toBeNull();
  });

  it('tolerates a ./ prefix on the file path', () => {
    expect(mavenModuleFor('./common/src/A.java', modules)).toBe('common');
  });
});

describe('affectedMavenModules', () => {
  it('deduplicates and sorts across files', () => {
    const modules = ['b-mod', 'a-mod'];
    expect(
      affectedMavenModules(
        ['b-mod/src/X.java', 'a-mod/src/Y.java', 'b-mod/pom.xml', 'README.md'],
        modules,
      ),
    ).toEqual(['a-mod', 'b-mod']);
  });

  it('returns nothing when no file lives in a module', () => {
    expect(affectedMavenModules(['README.md'], ['a-mod'])).toEqual([]);
  });
});
