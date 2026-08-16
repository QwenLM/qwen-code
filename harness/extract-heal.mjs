// Extract #9220's checkout self-heal step (qwen-code-pr-review.yml :: review-pr)
// verbatim, so the interaction test runs the real heal chain.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const [, , wfPath, outDir] = process.argv;
const doc = parse(readFileSync(wfPath, 'utf8'));
const steps = doc.jobs['review-pr'].steps;
const i = steps.findIndex((s) => /Reset workspace after failed checkout/.test(s.name || ''));
if (i === -1) throw new Error('heal step not found');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'heal.sh'), steps[i].run, { mode: 0o755 });
const checkout = steps[i - 1];
const retry = steps[i + 1];
writeFileSync(
  join(outDir, 'heal-meta.json'),
  JSON.stringify(
    {
      healIf: steps[i].if,
      firstCheckout: { name: checkout.name, uses: checkout.uses, continueOnError: checkout['continue-on-error'], with: checkout.with },
      retryCheckout: { name: retry.name, uses: retry.uses, with: retry.with },
    },
    null,
    2,
  ),
);
console.log(`heal step extracted from ${wfPath} -> ${outDir}`);
