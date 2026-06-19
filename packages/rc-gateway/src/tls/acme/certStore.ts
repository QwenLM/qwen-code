/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-disk store for an ACME-issued cert bundle, under `<baseDir>/<domain-slug>/`
 * (the cli passes `~/.qwen/rc/acme`). The leaf cert, private key, issuer chain,
 * and metadata are separate files so the https server can read exactly what it
 * needs. Private material is written 0600 under a 0700 directory — these keys are
 * the crown jewels and must never be group/world-readable.
 */
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export interface CertMeta {
  /** All domains (SAN) the cert covers; `domains[0]` is the primary/store key. */
  domains: string[];
  /** Cert expiry, ISO 8601 (drives renewal scheduling). */
  notAfter: string;
  /** When this bundle was issued, ISO 8601. */
  issuedAt: string;
}

export interface CertBundle {
  /** Leaf certificate, PEM. */
  cert: string;
  /** Private key for the leaf, PEM. */
  privateKey: string;
  /** Issuer chain (intermediates), PEM. */
  chain: string;
  meta: CertMeta;
}

/**
 * Map a domain to a filesystem-safe directory name: collapse anything outside
 * `[A-Za-z0-9._-]` (notably the wildcard `*`) to `_`, and neutralize `..` runs so
 * a pathological value can't escape `baseDir`. (`--acme-domain` is operator-set,
 * not remote — this is defense-in-depth, not the primary guard.)
 */
export function safeDirName(domain: string): string {
  const slug = domain.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\.+/g, '_');
  return slug || '_';
}

const FILES = {
  cert: 'cert.pem',
  privateKey: 'privkey.pem',
  chain: 'chain.pem',
  meta: 'meta.json',
} as const;

export class CertStore {
  constructor(private readonly baseDir: string) {}

  private dirFor(primaryDomain: string): string {
    return join(this.baseDir, safeDirName(primaryDomain));
  }

  /** Load the stored bundle for a domain, or `null` if none is stored yet. */
  async load(primaryDomain: string): Promise<CertBundle | null> {
    const dir = this.dirFor(primaryDomain);
    try {
      const [cert, privateKey, chain, metaRaw] = await Promise.all([
        readFile(join(dir, FILES.cert), 'utf8'),
        readFile(join(dir, FILES.privateKey), 'utf8'),
        readFile(join(dir, FILES.chain), 'utf8'),
        readFile(join(dir, FILES.meta), 'utf8'),
      ]);
      return { cert, privateKey, chain, meta: JSON.parse(metaRaw) as CertMeta };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Persist a bundle, forcing 0700 dir / 0600 files (mkdir/writeFile honor umask). */
  async save(primaryDomain: string, bundle: CertBundle): Promise<void> {
    const dir = this.dirFor(primaryDomain);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const writes: Array<[string, string]> = [
      [FILES.cert, bundle.cert],
      [FILES.privateKey, bundle.privateKey],
      [FILES.chain, bundle.chain],
      [FILES.meta, `${JSON.stringify(bundle.meta, null, 2)}\n`],
    ];
    for (const [name, contents] of writes) {
      const path = join(dir, name);
      await writeFile(path, contents, { mode: 0o600 });
      await chmod(path, 0o600);
    }
  }
}
