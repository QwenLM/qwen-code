// Stage B helper: deterministic structure checks for Markdown translations,
// so every arm is scored the same way before any human reads a sample.
// Per document it compares the source with an output: heading count, fenced
// code blocks (must be byte-identical — code is not translated), link
// targets, and whether the output is empty or looks truncated.
//
//   node docs/verification/batch-api/stage-b-structure-check.mjs \
//     <source-dir> <output-dir> [--ext .md]
//
// Files are paired by relative path. Prints one JSON object; `pass` is the
// structural verdict only — semantic quality still needs the human sample.
import fs from 'node:fs';
import path from 'node:path';

const [sourceDir, outputDir, ...rest] = process.argv.slice(2);
const extFlag = rest.indexOf('--ext');
const ext = extFlag >= 0 ? rest[extFlag + 1] : '.md';
if (!sourceDir || !outputDir) {
  console.error(
    'usage: stage-b-structure-check.mjs <source-dir> <output-dir> [--ext .md]',
  );
  process.exit(2);
}

function walk(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.name.endsWith(ext)) found.push(full);
  }
  return found;
}

const fences = (text) => text.match(/```[\s\S]*?```/g) ?? [];
const withoutFences = (text) => text.replace(/```[\s\S]*?```/g, '');
const headings = (text) =>
  withoutFences(text)
    .split('\n')
    .filter((line) => /^#{1,6}\s/.test(line)).length;
const links = (text) =>
  [...withoutFences(text).matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]);

const documents = [];
for (const source of walk(sourceDir)) {
  const relative = path.relative(sourceDir, source);
  const output = path.join(outputDir, relative);
  const result = { file: relative, problems: [] };
  if (!fs.existsSync(output)) {
    result.problems.push('missing output');
    documents.push(result);
    continue;
  }
  const src = fs.readFileSync(source, 'utf8');
  const out = fs.readFileSync(output, 'utf8');
  if (!out.trim()) result.problems.push('empty output');
  if (headings(src) !== headings(out)) {
    result.problems.push(`headings ${headings(src)} -> ${headings(out)}`);
  }
  const srcFences = fences(src);
  const outFences = fences(out);
  if (srcFences.length !== outFences.length) {
    result.problems.push(
      `code blocks ${srcFences.length} -> ${outFences.length}`,
    );
  } else if (srcFences.some((block, i) => block !== outFences[i])) {
    result.problems.push('a code block changed');
  }
  const srcLinks = links(src).sort().join('\n');
  const outLinks = links(out).sort().join('\n');
  if (srcLinks !== outLinks) result.problems.push('link targets differ');
  if (out.length < src.length * 0.3) {
    result.problems.push('output under 30% of source length');
  }
  documents.push(result);
}

const failed = documents.filter((doc) => doc.problems.length > 0);
console.log(
  JSON.stringify(
    {
      documents: documents.length,
      pass: documents.length - failed.length,
      fail: failed.length,
      failures: failed,
    },
    null,
    2,
  ),
);
