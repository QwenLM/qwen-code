import fs from 'node:fs';

// Teardown-only probe, deliberately narrower than the canonical
// packages/core/src/utils/process-liveness.ts: it takes no `pid <= 0` guard,
// skips the zombie exclusion on the EPERM/EACCES arm, and reads a vanished
// /proc entry as dead — the safe answer when the question is whether this
// script's own runtime leaked.
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
    // EPERM/EACCES: it exists under another owner.
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

// A daemon record's pid is also its process group, and the group outlives the
// leader that recorded it: after the leader exits a bare pid probe answers
// "gone" while the group's children keep writing under the workspace.
export function isTeardownTargetAlive(
  pid,
  { platform = process.platform, kill = process.kill } = {},
) {
  if (platform === 'win32') return isProcessAlive(pid, { platform, kill });
  try {
    kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return true;
    return isProcessAlive(pid, { platform, kill });
  }
}
