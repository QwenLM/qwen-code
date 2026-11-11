/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dangerous command detection for shell permission checks.
 *
 * This module provides a set of commands that are considered dangerous because
 * they can cause irreversible data loss, privilege escalation, or system damage.
 * These commands should always require explicit user confirmation, regardless
 * of whether they match an allow rule prefix.
 *
 * Unlike DANGEROUS_BASH_PATTERNS (in dangerousPatterns.ts), which lists commands
 * that are dangerous as *permission rule prefixes* (because they allow arbitrary
 * code execution), this module lists commands that are dangerous to *execute*
 * even with specific arguments.
 */

// ============================================================================
// Dangerous Command Set
// ============================================================================

/**
 * Commands that can cause irreversible system damage or data loss.
 *
 * Categories:
 * - **Destructive file operations**: rm, shred, srm
 * - **Disk/filesystem manipulation**: dd, mkfs, fdisk, parted, mount, umount
 * - **Network/firewall**: iptables, ip6tables, nftables, ufw
 * - **System services**: systemctl, launchctl, service, update-rc.d
 * - **Scheduled tasks**: crontab, at
 * - **Ownership/permissions**: chown, chmod (recursive)
 * - **Process control**: kill, killall, pkill
 * - **Mass execution**: xargs (with rm/del)
 * - **Privilege escalation**: sudo, doas, pkexec, su
 * - **Package management** (system-wide): apt, yum, dnf, pacman, brew (install/remove)
 * - **Git destructive**: git push --force, git reset --hard, git clean -f
 */
export const DANGEROUS_COMMAND_SET = new Set([
  // Destructive file operations
  'rm',
  'rmdir',
  'shred',
  'srm',
  'unlink',

  // Disk and filesystem manipulation
  'dd',
  'mkfs',
  'fdisk',
  'gdisk',
  'parted',
  'mount',
  'umount',
  'mkswap',
  'swapon',
  'swapoff',
  'losetup',
  'lvm',
  'mdadm',

  // Network/firewall
  'iptables',
  'ip6tables',
  'nft',
  'ufw',
  'firewall-cmd',

  // System services
  'systemctl',
  'launchctl',
  'service',
  'update-rc.d',
  'chkconfig',
  'initctl',

  // Scheduled tasks
  'crontab',
  'at',

  // Ownership and permissions (recursive can be very destructive)
  'chown',
  'chmod',
  'chgrp',
  'setfacl',

  // Process control
  'kill',
  'killall',
  'pkill',

  // Privilege escalation
  'sudo',
  'doas',
  'pkexec',
  'su',

  // Dangerous exec/eval
  'eval',
  'exec',

  // System modification
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'init',
  'telinit',

  // User/group management
  'useradd',
  'userdel',
  'usermod',
  'groupadd',
  'groupdel',
  'groupmod',
  'passwd',
  'chpasswd',

  // Container/VM management (can affect host)
  'docker',
  'podman',

  // Kernel modules
  'insmod',
  'rmmod',
  'modprobe',

  // SELinux/AppArmor
  'setenforce',
  'apparmor_parser',
]);

// ============================================================================
// Command Name Extraction
// ============================================================================

/**
 * Extracts the base command name from a command string.
 *
 * Handles:
 * - Absolute paths: `/usr/bin/rm` → `rm`
 * - Relative paths: `./scripts/deploy.sh` → `deploy.sh`
 * - Wrapper commands: `sudo rm`, `doas rm` → `rm`
 * - env prefix: `env rm` → `rm`
 * - Dotted variants: `python3.11` → `python3`
 *
 * Does NOT strip:
 * - Environment variable assignments (use stripAllLeadingEnvVars for that)
 * - Safe wrappers like timeout/nice (use stripSafeWrappers for that)
 *
 * @param command The command string (first word or full command line)
 * @returns The base command name, lowercased
 */
export function extractBaseCommandName(command: string): string {
  let cmd = command.trim();

  // Split to get first token
  const tokens = cmd.split(/\s+/);
  if (tokens.length === 0) return '';
  cmd = tokens[0]!;

  // Strip path: /usr/bin/rm → rm, ./scripts/deploy.sh → deploy.sh
  const lastSlash = cmd.lastIndexOf('/');
  if (lastSlash !== -1) {
    cmd = cmd.slice(lastSlash + 1);
  }
  // Also handle Windows backslash paths
  const lastBackslash = cmd.lastIndexOf('\\');
  if (lastBackslash !== -1) {
    cmd = cmd.slice(lastBackslash + 1);
  }

  // Handle wrapper commands that execute their arguments:
  // sudo, doas, pkexec, env — recurse into the next token
  const EXEC_WRAPPERS = new Set(['sudo', 'doas', 'pkexec', 'env']);
  if (EXEC_WRAPPERS.has(cmd.toLowerCase()) && tokens.length > 1) {
    // Skip flags for sudo/env (e.g., sudo -u root, env -i)
    let nextIdx = 1;
    while (nextIdx < tokens.length) {
      const next = tokens[nextIdx];
      if (next === '--') {
        nextIdx++;
        break;
      }
      if (next.startsWith('-')) {
        nextIdx++;
        // Some flags take a value: sudo -u root, env -S
        if (
          /^-[uUgCpHS]$/.test(next) ||
          next === '--user' ||
          next === '--set-home'
        ) {
          nextIdx++; // Skip the value too
        }
        continue;
      }
      // Skip env var assignments for `env`
      if (cmd.toLowerCase() === 'env' && /^[A-Za-z_]\w*=/.test(next)) {
        nextIdx++;
        continue;
      }
      break;
    }
    if (nextIdx < tokens.length) {
      // Recurse to handle chained wrappers: sudo env rm
      return extractBaseCommandName(tokens.slice(nextIdx).join(' '));
    }
  }

  return cmd.toLowerCase();
}

// ============================================================================
// Dangerous Command Matching
// ============================================================================

/**
 * Checks if a command matches a dangerous command, including dotted variants.
 *
 * Dotted variants handle versioned commands like:
 * - `python3.11` matches `python3` (not in DANGEROUS_COMMAND_SET, but example)
 * - `mkfs.ext4` matches `mkfs`
 * - `ip6tables.old` matches `ip6tables`
 *
 * @param command The full command string (may include arguments)
 * @returns true if the base command is in the dangerous set
 */
export function matchDangerousCommand(command: string): boolean {
  const baseName = extractBaseCommandName(command);
  if (!baseName) return false;

  // Direct match
  if (DANGEROUS_COMMAND_SET.has(baseName)) {
    return true;
  }

  // Dotted variant: try progressively shorter prefixes
  // e.g., mkfs.ext4 → try "mkfs.ext4", then "mkfs"
  const dotIndex = baseName.indexOf('.');
  if (dotIndex > 0) {
    const prefix = baseName.slice(0, dotIndex);
    if (DANGEROUS_COMMAND_SET.has(prefix)) {
      return true;
    }
  }

  return false;
}
