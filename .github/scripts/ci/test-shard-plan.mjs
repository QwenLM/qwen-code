// Splits a suite's test files into `count` shards by their measured run time
// (test-durations.json), instead of Vitest's equal-count split by path hash.
// Every shard computes the same plan from the same inputs: the order and the
// tie-breaks depend only on the paths and the durations, never on the host.

/**
 * @param {string[]} files suite-relative test file paths, `/`-separated
 * @param {{workers: number, overheadSeconds: number, files: Record<string, number>}} suite
 * @param {number} count
 * @returns {string[][]} the files of each shard, shard 1 first
 */
export function planShards(files, suite, count) {
  const cost = (file) => suite.overheadSeconds + (suite.files[file] ?? 0);
  const order = [...new Set(files)].sort(
    (a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const shards = Array.from({ length: count }, () => ({
    files: [],
    total: 0,
    longest: 0,
  }));
  // A shard runs its files on `workers` workers, so it finishes no sooner than
  // its total over the workers, nor than its longest single file. Among the
  // shards a file would not make the slowest, the least loaded takes it.
  const finish = (shard, seconds) =>
    Math.max(shard.longest, seconds, (shard.total + seconds) / suite.workers);
  let slowest = 0;
  for (const file of order) {
    const seconds = cost(file);
    let best;
    let bestFinish = Infinity;
    for (const shard of shards) {
      const end = Math.max(finish(shard, seconds), slowest);
      if (
        end < bestFinish ||
        (end === bestFinish && shard.total < best.total)
      ) {
        best = shard;
        bestFinish = end;
      }
    }
    best.files.push(file);
    best.total += seconds;
    best.longest = Math.max(best.longest, seconds);
    slowest = bestFinish;
  }
  return shards.map((shard) => shard.files);
}
