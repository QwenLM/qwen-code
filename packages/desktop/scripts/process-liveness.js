import fs from 'node:fs';

export function isProcessAlive(
  pid,
  {
    platform = process.platform,
    kill = process.kill,
    readStat = (statPath) => fs.readFileSync(statPath, 'utf8'),
  } = {},
) {
  try {
    kill(pid, 0);
  } catch (error) {
    // EPERM/EACCES: it exists under another owner. Mirrors the canonical
    // packages/core/src/utils/process-liveness.ts; keep both in sync.
    return error?.code === 'EPERM' || error?.code === 'EACCES';
  }
  if (platform !== 'linux') return true;
  try {
    const stat = readStat(`/proc/${pid}/stat`);
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0 || stat[closingParen + 1] !== ' ') return true;
    return stat[closingParen + 2] !== 'Z';
  } catch (error) {
    return error?.code !== 'ENOENT';
  }
}
