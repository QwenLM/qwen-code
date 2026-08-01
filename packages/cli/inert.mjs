import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { parse } from 'yaml';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runExtractStep } from './src/commands/review/extract-step.js';
const dir = '/root/git/qwen-code-review/.github/workflows';
const out = mkdtempSync(join(tmpdir(), 'inert-'));
let checked = 0; const bad = [];
for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
  let d; try { d = parse(readFileSync(`${dir}/${f}`, 'utf8')); } catch { continue; }
  for (const [jid, j] of Object.entries(d?.jobs ?? {}))
    (j?.steps ?? []).forEach((s, i) => {
      if (typeof s?.run !== 'string') return;
      const p = join(out, `s${checked}.sh`);
      runExtractStep({ workflow: `${dir}/${f}`, job: jid, step: String(i), out: p });
      const emitted = readFileSync(p, 'utf8');
      const body = s.run.endsWith('\n') ? s.run : s.run + '\n';
      if (!emitted.endsWith(body)) { bad.push(`${f}/${jid}/${i}: BODY NOT VERBATIM`); checked++; return; }
      const header = emitted.slice(0, emitted.length - body.length);
      for (const [n, l] of header.split('\n').entries())
        if (l !== '' && !/^#/.test(l) && !/^set -e(o pipefail)?$/.test(l))
          bad.push(`${f}/${jid}/${i} header line ${n + 1}: ${JSON.stringify(l.slice(0, 90))}`);
      checked++;
    });
}
console.log(`checked=${checked} violations=${bad.length}`);
bad.slice(0, 10).forEach((b) => console.log('  ' + b));
