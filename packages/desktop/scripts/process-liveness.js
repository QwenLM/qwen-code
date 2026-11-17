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
  {
    platform = process.platform,
    kill = process.kill,
    readDir = (dir) => fs.readdirSync(dir),
    readStat = (statPath) => fs.readFileSync(statPath, 'utf8'),
  } = {},
) {
  if (platform === 'win32') return isProcessAlive(pid, { platform, kill });
  try {
    kill(-pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return true;
    return isProcessAlive(pid, { platform, kill });
  }
  // The group probe also answers for members that can no longer write: an
  // exited daemon the container's PID 1 has not reaped keeps its group
  // "alive" as a zombie, which would fail teardown on a runtime that is gone.
  if (platform !== 'linux') return true;
  return groupHasLiveMember(pid, { readDir, readStat });
}

function groupHasLiveMember(pgid, { readDir, readStat }) {
  let entries;
  try {
    entries = readDir('/proc');
  } catch {
    // Membership unknown: keep the group probe's answer rather than ending a
    // drain on a failed scan.
    return true;
  }
  let members = 0;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readStat(`/proc/${entry}/stat`);
    } catch {
      // The member exited between readdir and read, which is the wanted state.
      continue;
    }
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) continue;
    // `/proc/<pid>/stat` after `comm`: state, ppid, pgrp, ...
    const fields = stat
      .slice(closingParen + 2)
      .trim()
      .split(' ');
    if (fields.length < 3 || Number(fields[2]) !== pgid) continue;
    if (fields[0] !== 'Z') return true;
    members += 1;
  }
  // Nothing observed is not the same as "only zombies": when /proc hides the
  // group, the group probe that answered alive stays the better evidence.
  return members === 0;
}
