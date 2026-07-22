/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('PostgreSQL isolation migration', () => {
  it('forces RLS on every tenant-bearing online table', async () => {
    const sql = await readFile(
      new URL('../migrations/001-initial.sql', import.meta.url),
      'utf8',
    );
    const tables = [
      'workspace_bindings',
      'personal_memory_preferences',
      'memory_records',
      'provider_bindings',
      'memory_source_receipts',
      'memory_activation_reservations',
      'memory_erasure_reservations',
      'raw_events',
      'memory_feedback',
      'runtime_capability_replays',
    ];

    for (const table of tables) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
  });

  it('uses tenant-qualified identities, references, and idempotency keys', async () => {
    const sql = await readFile(
      new URL('../migrations/001-initial.sql', import.meta.url),
      'utf8',
    );

    expect(sql).toContain('PRIMARY KEY (tenant_id, id)');
    expect(sql).toContain('UNIQUE (tenant_id, source_operation_id)');
    expect(sql).toContain('PRIMARY KEY (tenant_id, event_id)');
    expect(sql).toContain('FOREIGN KEY (tenant_id, canonical_memory_id)');
    expect(sql).toContain('FOREIGN KEY (tenant_id, memory_id)');
    expect(sql).toContain('CREATE TABLE memory_erasure_reservations');
    expect(sql).toContain(
      'ALTER TABLE memory_erasure_reservations FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain("current_setting('app.tenant_id', true)");
    expect(sql).toContain("purge_at <= received_at + interval '24 hours'");
    expect(sql).toContain('content_ciphertext text NOT NULL');
    expect(sql).toContain('capability_fingerprint text NOT NULL');
    expect(sql).toContain('CREATE POLICY memory_source_receipts_update_policy');
    expect(sql).toMatch(
      /memory_source_receipts_update_policy[\s\S]*?FOR UPDATE[\s\S]*?m\.id = memory_source_receipts\.canonical_memory_id/,
    );
    expect(sql).not.toContain('summary_ciphertext');
    expect(sql).not.toContain('references_json');
  });

  it('keeps source receipts free of content and subject linkage', async () => {
    const sql = await readFile(
      new URL('../migrations/001-initial.sql', import.meta.url),
      'utf8',
    );
    const receiptTable = sql.match(
      /CREATE TABLE memory_source_receipts \(([\s\S]*?)\n\);/,
    )?.[1];

    expect(receiptTable).toBeDefined();
    expect(receiptTable).not.toContain('principal_id');
    expect(receiptTable).not.toContain('repository_id');
    expect(receiptTable).not.toContain('content_ciphertext');
    expect(receiptTable).not.toContain('content_key_handle');
  });
});
