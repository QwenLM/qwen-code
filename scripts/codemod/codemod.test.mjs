// Self-test for ink-to-opentui.mjs. Run with: node scripts/codemod/codemod.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSource } from './ink-to-opentui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const codemod = join(here, 'ink-to-opentui.mjs');
const before = readFileSync(join(here, 'fixtures', 'before.tsx'), 'utf8');
const after = readFileSync(join(here, 'fixtures', 'after.tsx'), 'utf8');

let failures = 0;
let count = 0;

function test(name, fn) {
  count++;
  try {
    fn();
    console.log(`ok ${count} - ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${count} - ${name}`);
    console.error(err && err.message ? err.message : err);
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [codemod, ...args], { encoding: 'utf8' });
}

test('fixture: transform matches after.tsx', () => {
  const res = transformSource(before);
  assert.equal(res.changed, true);
  assert.equal(res.output, after);
  assert.equal(res.notes.length, 0);
});

test('fixture: idempotent on after.tsx', () => {
  const res = transformSource(after);
  assert.equal(res.changed, false);
  assert.equal(res.output, after);
});

test('fixture: stats count renamed elements and collected props', () => {
  const res = transformSource(before);
  assert.equal(res.stats.box, 5);
  assert.equal(res.stats.text, 3);
  assert.equal(res.stats.propsCollected, 12);
  assert.equal(res.stats.styleTags, 5);
});

const tmpDir = join(here, '.tmp-test');
mkdirSync(tmpDir, { recursive: true });
const tmpFile = join(tmpDir, 'sample.tsx');

try {
  test('cli: default is dry-run and writes nothing', () => {
    writeFileSync(tmpFile, before);
    const r = runCli([tmpFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\]/);
    assert.match(r.stdout, /dry-run, nothing written/);
    assert.equal(readFileSync(tmpFile, 'utf8'), before);
  });

  test('cli: --dry-run writes nothing', () => {
    writeFileSync(tmpFile, before);
    const r = runCli(['--dry-run', tmpFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(tmpFile, 'utf8'), before);
  });

  test('cli: --apply rewrites to fixture after.tsx', () => {
    writeFileSync(tmpFile, before);
    const r = runCli(['--apply', tmpFile]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[apply\]/);
    assert.match(r.stdout, /written/);
    assert.equal(readFileSync(tmpFile, 'utf8'), after);
  });

  test('cli: directory input is scanned', () => {
    writeFileSync(tmpFile, before);
    const r = runCli(['--dry-run', tmpDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sample\.tsx/);
    assert.equal(readFileSync(tmpFile, 'utf8'), before);
  });
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

test('manual: spread attribute keeps props, still renames', () => {
  const src = 'const x = <Box {...rest} padding={1}>hi</Box>;';
  const res = transformSource(src);
  assert.equal(res.output, 'const x = <box {...rest} padding={1}>hi</box>;');
  assert.ok(res.notes.some((nt) => /spread/.test(nt.msg)));
});

test('manual: malformed attribute leaves file unchanged', () => {
  const src = 'const x = <Box padding=1>bad</Box>;';
  const res = transformSource(src);
  assert.equal(res.output, src);
  assert.equal(res.changed, false);
  assert.equal(res.notes.length, 1);
});

test('manual: existing style with spread renames only', () => {
  const src = 'const x = <Box style={{ ...base }} padding={1}>hi</Box>;';
  const res = transformSource(src);
  assert.equal(
    res.output,
    'const x = <box style={{ ...base }} padding={1}>hi</box>;',
  );
  assert.ok(
    res.notes.some((nt) => /spread inside existing style object/.test(nt.msg)),
  );
});

test('manual: conflicting key in existing style object', () => {
  const src = 'const x = <Box style={{ padding: 4 }} padding={1}>x</Box>;';
  const res = transformSource(src);
  assert.equal(
    res.output,
    'const x = <box style={{ padding: 4 }} padding={1}>x</box>;',
  );
  assert.ok(res.notes.some((nt) => /already present/.test(nt.msg)));
});

test('manual: non-object style expression is not merged', () => {
  const src = 'const x = <Box style={baseStyle} padding={1}>x</Box>;';
  const res = transformSource(src);
  assert.equal(
    res.output,
    'const x = <box style={baseStyle} padding={1}>x</box>;',
  );
  assert.ok(res.notes.length >= 1);
});

test('manual: mismatched closing tag leaves file unchanged', () => {
  const src = 'const x = <Box>a</Text>;';
  const res = transformSource(src);
  assert.equal(res.output, src);
  assert.ok(res.notes.length >= 1);
});

test('ignore: generics, foreign tags and strings untouched', () => {
  const src = [
    'const r = useRef<Box>(null);',
    'const v = <div className="a"><span>hi</span></div>;',
    'const s = "<Box>not jsx</Box>";',
    '',
  ].join('\n');
  const res = transformSource(src);
  assert.equal(res.changed, false);
  assert.equal(res.output, src);
});

test('regex mask: closing-tag slash is not a regex start', () => {
  const src =
    'const a = <Box>x</Box>; const b = <Text>y</Text>; const half = n / 2;';
  const res = transformSource(src);
  assert.equal(
    res.output,
    'const a = <box>x</box>; const b = <text>y</text>; const half = n / 2;',
  );
  assert.equal(res.stats.text, 1);
  assert.equal(res.notes.length, 0);
});

test('manual: string style value with backslash is not copied verbatim', () => {
  const src = 'const x = <Box margin="a\\b" padding={1}>x</Box>';
  const res = transformSource(src);
  assert.equal(res.output, 'const x = <box margin="a\\b" padding={1}>x</box>');
  assert.ok(res.notes.some((nt) => /escape\/entity semantics/.test(nt.msg)));
});

test('manual: string style value with HTML entity is not copied verbatim', () => {
  const src = 'const x = <Box margin="1&nbsp;2">x</Box>';
  const res = transformSource(src);
  assert.equal(res.output, 'const x = <box margin="1&nbsp;2">x</box>');
  assert.ok(res.notes.some((nt) => /escape\/entity semantics/.test(nt.msg)));
});

if (failures > 0) {
  console.error(`# ${failures}/${count} test(s) failed`);
  process.exit(1);
}
console.log(`# ${count}/${count} tests passed`);
