// Vitest `sequence.sequencer` for the suites listed in test-durations.json:
// `--shard` splits their files by measured run time (see test-shard-plan.mjs),
// and each shard starts its longest files first. A suite with no entry keeps
// Vitest's default split and order.
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BaseSequencer } from 'vitest/node';

import { planShards } from './test-shard-plan.mjs';

const durations = JSON.parse(
  readFileSync(new URL('./test-durations.json', import.meta.url), 'utf8'),
);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const slash = (path) => path.split(sep).join('/');

export class DurationSequencer extends BaseSequencer {
  suite() {
    return durations[slash(relative(repoRoot, this.ctx.config.root))];
  }

  path(spec) {
    return slash(relative(this.ctx.config.root, spec.moduleId));
  }

  async shard(files) {
    const suite = this.suite();
    if (!suite) return super.shard(files);
    const { index, count } = this.ctx.config.shard;
    const byPath = new Map(files.map((spec) => [this.path(spec), spec]));
    return planShards([...byPath.keys()], suite, count)[index - 1].map((path) =>
      byPath.get(path),
    );
  }

  async sort(files) {
    const suite = this.suite();
    if (!suite || !this.ctx.config.shard) return super.sort(files);
    const seconds = (spec) => suite.files[this.path(spec)] ?? 0;
    return [...files].sort((a, b) => seconds(b) - seconds(a));
  }
}
