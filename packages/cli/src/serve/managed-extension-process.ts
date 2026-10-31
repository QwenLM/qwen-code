/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ManagedExtensionExecutionUnknownError } from './managed-extension-error.js';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import {
  promises as fs,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJSON } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import type { Writable } from 'node:stream';
import { HookCommandCgroup } from '@qwen-code/qwen-code-core/hooks/hook-command-cgroup.js';
import type { ManagedRuntimeLedger } from './managed-runtime-ledger.js';

export type ManagedExtensionProcessMode =
  | 'linux-cgroup'
  | 'developer-process-group';

export interface ManagedExtensionProcessReceipt {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly configRevision: number;
  readonly mode: ManagedExtensionProcessMode;
  readonly scope: 'process_tree' | 'process_group';
  readonly state: 'stopped' | 'outcome_unknown';
  readonly coverage?: 'registered-owners';
  readonly journalId?: string;
}

interface Owner {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly configRevision: number;
  readonly child?: ChildProcess;
  readonly pgid?: number;
  readonly startedAt: number;
  readonly uptimeMs: number;
  readonly unit?: HookCommandCgroup;
}

// The target command is not even read until its group is durably registered.
const DEVELOPER_LAUNCHER = String.raw`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
let message = '';
const byte = Buffer.alloc(1);
while (fs.readSync(3, byte, 0, 1, null)) {
  if (byte[0] === 10) break;
  message += byte.toString();
}
if (!message) process.exit(1);
const input = JSON.parse(message);
const child = spawn(input.executable, input.args, { env: input.env, stdio: 'inherit' });
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
`;

export class ManagedExtensionProcessOwners {
  private readonly owners = new Map<string, Owner>();
  private readonly receipts = new Map<string, ManagedExtensionProcessReceipt>();
  readonly journalId: string;
  private readonly recovering: Promise<void>;
  private journalUpdates: Promise<void> = Promise.resolve();
  private readonly journalOwners = new Set<string>();
  private readonly bootIdentity =
    process.platform === 'darwin'
      ? execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
          encoding: 'utf8',
        }).trim()
      : process.platform === 'linux'
        ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
        : '';
  private readonly stopping = new Map<
    string,
    Promise<ManagedExtensionProcessReceipt>
  >();

  constructor(
    readonly mode: ManagedExtensionProcessMode,
    private readonly options: {
      readonly cgroupRoot?: string;
      readonly ledger?: ManagedRuntimeLedger;
      readonly directory?: string;
    },
  ) {
    if (
      (mode === 'linux-cgroup' && process.platform !== 'linux') ||
      (mode === 'developer-process-group' &&
        (process.platform !== 'darwin' || !options.ledger))
    )
      throw new Error('Extension process mode is unavailable on this Runtime.');
    if (options.directory) {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      const marker = path.join(options.directory, '.journal-id');
      try {
        this.journalId = readFileSync(marker, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.journalId = randomUUID();
        writeFileSync(marker, this.journalId, { flag: 'wx', mode: 0o600 });
        writeFileSync(path.join(options.directory, '.owners.json'), '[]', {
          flag: 'wx',
          mode: 0o600,
        });
      }
    } else this.journalId = randomUUID();
    this.recovering = this.loadOwners();
    void this.recovering.catch(() => undefined);
  }

  async start(input: {
    readonly sessionId: string;
    readonly configRevision: number;
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
  }): Promise<{ ownerId: string; child: ChildProcess }> {
    await this.recovering;
    if (
      !input.sessionId ||
      !Number.isSafeInteger(input.configRevision) ||
      input.configRevision < 1
    )
      throw new Error('Invalid extension process owner.');
    const ownerId = `extension-${randomUUID()}`;
    const startedAt = Date.now();
    const uptimeMs = os.uptime() * 1000;
    await this.saveOwner({
      ownerId,
      sessionId: input.sessionId,
      configRevision: input.configRevision,
      startedAt,
      uptimeMs,
    });
    const unit =
      this.mode === 'linux-cgroup'
        ? HookCommandCgroup.create(this.options.cgroupRoot, ownerId)
        : undefined;
    const launch = unit?.launch(input.executable, [...input.args], input.env);
    const child = spawn(
      launch?.executable ?? process.execPath,
      launch?.args ?? ['--input-type=commonjs', '--eval', DEVELOPER_LAUNCHER],
      {
        cwd: input.cwd,
        env: launch?.env ?? { PATH: '/usr/bin:/bin' },
        detached: !unit,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      },
    );
    child.on('error', () => undefined);
    child.stdio[3]?.on('error', () => undefined);
    const owner = {
      ownerId,
      sessionId: input.sessionId,
      configRevision: input.configRevision,
      child,
      unit,
      startedAt,
      uptimeMs,
      pgid: child.pid,
    };
    this.owners.set(ownerId, owner);
    try {
      await this.saveOwner(owner);
      if (unit) {
        let joined = '';
        child.stdio[3]?.on('data', (chunk: Buffer) => {
          joined += chunk.toString();
        });
        for (
          let attempt = 0;
          attempt < 40 && !joined.includes('joined\n');
          attempt++
        ) {
          if (
            joined.includes('unavailable\n') ||
            child.exitCode !== null ||
            child.signalCode !== null
          )
            throw new Error('Extension process membership is unproven.');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!joined.includes('joined\n'))
          throw new Error('Extension process membership is unproven.');
      } else {
        if (!child.pid) throw new Error('Extension process failed to start.');
        this.options.ledger!.addGroup({
          pgid: child.pid,
          callId: ownerId,
          startedAt,
        });
        (child.stdio[3] as Writable).end(
          `${JSON.stringify({ executable: input.executable, args: input.args, env: input.env })}\n`,
        );
      }
      return { ownerId, child };
    } catch (error) {
      // Unknown cleanup keeps the owner: nobody can reinterpret a failed
      // startup as permission to discard its process identity.
      child.stdio[3]?.destroy();
      child.kill('SIGKILL');
      const receipt = await this.stop(ownerId).catch(() => undefined);
      if (receipt?.state !== 'stopped')
        throw new ManagedExtensionExecutionUnknownError(
          'Extension process startup cleanup is unknown.',
        );
      throw error;
    }
  }

  async hasLiveSessionOwners(
    sessionId: string,
    except: ReadonlySet<string> = new Set(),
  ): Promise<boolean> {
    await this.recovering;
    return [...this.owners.values()].some(
      (owner) =>
        owner.sessionId === sessionId &&
        !except.has(owner.ownerId) &&
        this.receipts.get(owner.ownerId)?.state !== 'stopped',
    );
  }

  async coverSession(sessionId: string, configRevision: number): Promise<void> {
    await this.recovering;
    if (!this.options.directory)
      throw new Error('Extension owner scope requires a durable journal.');
    const file = path.join(
      this.options.directory,
      `.scope-${createHash('sha256').update(sessionId).digest('hex')}.json`,
    );
    await atomicWriteJSON(
      file,
      {
        sessionId,
        configRevision,
        journalId: this.journalId,
        ownerId: `coverage-${randomUUID()}`,
      },
      { mode: 0o600 },
    );
  }

  async stopSession(
    sessionId: string,
    except: ReadonlySet<string> = new Set(),
  ): Promise<readonly ManagedExtensionProcessReceipt[]> {
    await this.recovering;
    const stopped = await Promise.all(
      [...this.owners.values()]
        .filter(
          (owner) =>
            owner.sessionId === sessionId && !except.has(owner.ownerId),
        )
        .map((owner) => this.stop(owner.ownerId)),
    );
    if (
      except.size > 0 ||
      !this.options.directory ||
      stopped.some((receipt) => receipt.state !== 'stopped')
    )
      return stopped;
    const coverage = JSON.parse(
      await fs.readFile(
        path.join(
          this.options.directory,
          `.scope-${createHash('sha256').update(sessionId).digest('hex')}.json`,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    if (
      coverage['sessionId'] !== sessionId ||
      coverage['journalId'] !== this.journalId ||
      typeof coverage['ownerId'] !== 'string' ||
      !Number.isSafeInteger(coverage['configRevision'])
    )
      throw new Error('Extension owner coverage is unavailable.');
    return [
      ...stopped,
      {
        ownerId: coverage['ownerId'],
        sessionId,
        configRevision: Number(coverage['configRevision']),
        mode: this.mode,
        scope: this.mode === 'linux-cgroup' ? 'process_tree' : 'process_group',
        state: 'stopped',
        coverage: 'registered-owners',
        journalId: this.journalId,
      },
    ];
  }

  stop(ownerId: string): Promise<ManagedExtensionProcessReceipt> {
    let pending = this.stopping.get(ownerId);
    if (!pending) {
      pending = this.stopOwner(ownerId).finally(() =>
        this.stopping.delete(ownerId),
      );
      this.stopping.set(ownerId, pending);
    }
    return pending;
  }

  async stopAll(): Promise<readonly ManagedExtensionProcessReceipt[]> {
    await this.recovering;
    return Promise.all([...this.owners.keys()].map((id) => this.stop(id)));
  }

  private async stopOwner(
    ownerId: string,
  ): Promise<ManagedExtensionProcessReceipt> {
    await this.recovering;
    const existing = this.receipts.get(ownerId);
    if (existing) return existing;
    const owner = this.owners.get(ownerId);
    if (!owner) throw new Error('Extension process owner is unknown.');
    let stopped = false;
    try {
      if (owner.unit) {
        await owner.unit.terminate(1_000);
        stopped = await owner.unit.waitForEmpty(5_000);
        if (stopped) owner.unit.remove();
      } else if (owner.pgid && !this.options.ledger!.hasIntegrityFailure) {
        stopped =
          (await this.options.ledger!.stopWitnessedGroup(owner.pgid, 5000)) ===
          'gone';
        stopped &&= !this.options.ledger!.hasIntegrityFailure;
      }
    } catch {
      stopped = false;
    }
    const receipt: ManagedExtensionProcessReceipt = {
      ownerId,
      sessionId: owner.sessionId,
      configRevision: owner.configRevision,
      mode: this.mode,
      scope: this.mode === 'linux-cgroup' ? 'process_tree' : 'process_group',
      state: stopped ? 'stopped' : 'outcome_unknown',
    };
    if (stopped) {
      if (this.options.directory)
        await atomicWriteJSON(
          path.join(this.options.directory, `${ownerId}.receipt.json`),
          receipt,
          { mode: 0o600 },
        );
      this.receipts.set(ownerId, receipt);
    }
    return receipt;
  }
  private async saveOwner(owner: Omit<Owner, 'child' | 'unit'>): Promise<void> {
    if (!this.options.directory) return;
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    this.journalOwners.add(owner.ownerId);
    await atomicWriteJSON(
      path.join(this.options.directory, `${owner.ownerId}.json`),
      {
        version: 1,
        bootIdentity: this.bootIdentity,
        mode: this.mode,
        ownerId: owner.ownerId,
        sessionId: owner.sessionId,
        configRevision: owner.configRevision,
        startedAt: owner.startedAt,
        uptimeMs: owner.uptimeMs,
        pgid: owner.pgid ?? null,
      },
      { mode: 0o600 },
    );
    this.journalUpdates = this.journalUpdates.then(() =>
      atomicWriteJSON(
        path.join(this.options.directory!, '.owners.json'),
        [...this.journalOwners].sort(),
        { mode: 0o600 },
      ),
    );
    await this.journalUpdates;
  }

  private async loadOwners(): Promise<void> {
    if (!this.options.directory) return;
    await fs.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const index = JSON.parse(
      await fs.readFile(
        path.join(this.options.directory, '.owners.json'),
        'utf8',
      ),
    ) as unknown;
    if (
      !Array.isArray(index) ||
      !index.every(
        (id) => typeof id === 'string' && /^extension-[0-9a-f-]+$/u.test(id),
      )
    )
      throw new Error('Extension owner index is invalid.');
    const files = await fs.readdir(this.options.directory);
    for (const id of index) {
      if (!files.includes(`${id}.json`))
        throw new Error('Original extension owner record is missing.');
      this.journalOwners.add(id);
    }
    for (const file of files) {
      if (!/^extension-[0-9a-f-]+\.json$/u.test(file)) continue;
      const value = JSON.parse(
        await fs.readFile(path.join(this.options.directory, file), 'utf8'),
      ) as Record<string, unknown>;
      if (
        value['version'] !== 1 ||
        value['bootIdentity'] !== this.bootIdentity ||
        value['mode'] !== this.mode ||
        typeof value['ownerId'] !== 'string' ||
        `${value['ownerId']}.json` !== file ||
        typeof value['sessionId'] !== 'string' ||
        !Number.isSafeInteger(value['configRevision']) ||
        !Number.isFinite(value['startedAt']) ||
        !Number.isFinite(value['uptimeMs'])
      )
        throw new Error('Extension owner journal is invalid.');
      // Never infer ownership after a reboot or a clock-domain inconsistency.
      if (Number(value['uptimeMs']) > os.uptime() * 1000)
        throw new Error('Original extension owner boot is unavailable.');
      const owner: Owner = {
        ownerId: value['ownerId'],
        sessionId: value['sessionId'],
        configRevision: Number(value['configRevision']),
        startedAt: Number(value['startedAt']),
        uptimeMs: Number(value['uptimeMs']),
        pgid: typeof value['pgid'] === 'number' ? value['pgid'] : undefined,
        ...(this.mode === 'linux-cgroup'
          ? {
              unit: HookCommandCgroup.attach(
                this.options.cgroupRoot,
                value['ownerId'],
              ),
            }
          : {}),
      };
      this.owners.set(owner.ownerId, owner);
      if (this.mode === 'developer-process-group' && owner.pgid)
        this.options.ledger!.addGroup({
          pgid: owner.pgid,
          callId: owner.ownerId,
          startedAt: owner.startedAt,
          uptimeMs: owner.uptimeMs,
        });
      try {
        const receipt = JSON.parse(
          await fs.readFile(
            path.join(this.options.directory, `${owner.ownerId}.receipt.json`),
            'utf8',
          ),
        ) as ManagedExtensionProcessReceipt;
        if (
          receipt.ownerId !== owner.ownerId ||
          receipt.sessionId !== owner.sessionId ||
          receipt.mode !== this.mode ||
          receipt.configRevision !== owner.configRevision ||
          receipt.state !== 'stopped' ||
          receipt.scope !==
            (this.mode === 'linux-cgroup' ? 'process_tree' : 'process_group')
        )
          throw new Error('Extension stop receipt conflicts.');
        this.receipts.set(owner.ownerId, receipt);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
