BEGIN;

CREATE TABLE workspace_bindings (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  revocation_epoch integer NOT NULL DEFAULT 0 CHECK (revocation_epoch >= 0),
  last_verified_at timestamptz NOT NULL,
  authz_expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'revoked', 'draining')),
  PRIMARY KEY (tenant_id, workspace_id),
  UNIQUE (tenant_id, principal_id, repository_id, workspace_id)
);

CREATE TABLE personal_memory_preferences (
  tenant_id text NOT NULL,
  principal_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('off', 'read_only', 'read_write')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE TABLE runtime_capability_replays (
  tenant_id text NOT NULL,
  capability_id text NOT NULL,
  principal_id text NOT NULL,
  capability_fingerprint text NOT NULL,
  request_binding text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, capability_id)
);

CREATE TABLE memory_records (
  tenant_id text NOT NULL,
  id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('personal', 'repository')),
  scope_id text NOT NULL,
  content_ciphertext text NOT NULL,
  content_key_handle text NOT NULL,
  authority text NOT NULL,
  lifecycle_state text NOT NULL CHECK (
    lifecycle_state IN (
      'candidate', 'active', 'rejected', 'superseded', 'expired', 'tombstoned'
    )
  ),
  erasure_state text NOT NULL CHECK (
    erasure_state IN ('live', 'pending_erasure', 'erased')
  ),
  version integer NOT NULL CHECK (version > 0),
  source_operation_id text NOT NULL,
  source_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_operation_id)
);

CREATE TABLE provider_bindings (
  tenant_id text NOT NULL,
  canonical_memory_id uuid NOT NULL,
  canonical_version integer NOT NULL,
  provider_memory_id text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('personal', 'repository')),
  entity_id text NOT NULL,
  state text NOT NULL CHECK (
    state IN ('active', 'pending_delete', 'deleted', 'failed')
  ),
  PRIMARY KEY (tenant_id, canonical_memory_id, canonical_version),
  UNIQUE (tenant_id, provider_memory_id),
  FOREIGN KEY (tenant_id, canonical_memory_id)
    REFERENCES memory_records (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE memory_source_receipts (
  tenant_id text NOT NULL,
  source_operation_id text NOT NULL,
  canonical_memory_id uuid NOT NULL,
  source_fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('live', 'erased')),
  PRIMARY KEY (tenant_id, source_operation_id)
);

CREATE TABLE memory_activation_reservations (
  tenant_id text NOT NULL,
  canonical_memory_id uuid NOT NULL,
  canonical_version integer NOT NULL CHECK (canonical_version > 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, canonical_memory_id),
  FOREIGN KEY (tenant_id, canonical_memory_id)
    REFERENCES memory_records (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE memory_erasure_reservations (
  tenant_id text NOT NULL,
  canonical_memory_id uuid NOT NULL,
  canonical_version integer NOT NULL CHECK (canonical_version > 0),
  scope text NOT NULL CHECK (scope IN ('personal', 'repository')),
  reason text NOT NULL CHECK (
    reason IN (
      'user_request', 'maintainer_request', 'candidate_rejected',
      'retention_expired', 'tenant_offboarding'
    )
  ),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, canonical_memory_id),
  FOREIGN KEY (tenant_id, canonical_memory_id)
    REFERENCES memory_records (tenant_id, id)
    ON DELETE CASCADE
);

CREATE TABLE raw_events (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  principal_id text NOT NULL,
  workspace_id text NOT NULL,
  repository_id text NOT NULL,
  session_id text NOT NULL,
  turn_id text,
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source_fingerprint text NOT NULL,
  purge_at timestamptz NOT NULL,
  payload_ciphertext text NOT NULL,
  content_key_handle text NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CHECK (purge_at <= received_at + interval '24 hours')
);

CREATE TABLE memory_feedback (
  tenant_id text NOT NULL,
  event_id uuid NOT NULL,
  memory_id uuid NOT NULL,
  memory_version integer NOT NULL,
  principal_id text NOT NULL,
  signal text NOT NULL CHECK (
    signal IN ('helpful', 'not_helpful', 'stale', 'unsafe')
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source_fingerprint text NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  FOREIGN KEY (tenant_id, memory_id)
    REFERENCES memory_records (tenant_id, id)
    ON DELETE CASCADE
);

ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_records FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_bindings FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_source_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_source_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_activation_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_activation_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_erasure_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_erasure_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE raw_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_events FORCE ROW LEVEL SECURITY;
ALTER TABLE personal_memory_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_memory_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE memory_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_feedback FORCE ROW LEVEL SECURITY;
ALTER TABLE runtime_capability_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_capability_replays FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_bindings_runtime_policy ON workspace_bindings
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND repository_id = current_setting('app.repository_id', true)
  );

CREATE POLICY memory_records_runtime_policy ON memory_records
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND (
      (scope = 'personal' AND scope_id = current_setting('app.principal_id', true))
      OR
      (scope = 'repository' AND scope_id = current_setting('app.repository_id', true))
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND (
      (scope = 'personal' AND scope_id = current_setting('app.principal_id', true))
      OR
      (scope = 'repository' AND scope_id = current_setting('app.repository_id', true))
    )
  );

CREATE POLICY provider_bindings_runtime_policy ON provider_bindings
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = provider_bindings.tenant_id
        AND m.id = provider_bindings.canonical_memory_id
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = provider_bindings.tenant_id
        AND m.id = provider_bindings.canonical_memory_id
    )
  );

CREATE POLICY memory_source_receipts_read_policy ON memory_source_receipts
  FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY memory_source_receipts_insert_policy ON memory_source_receipts
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE POLICY memory_source_receipts_update_policy ON memory_source_receipts
  FOR UPDATE
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_source_receipts.tenant_id
        AND m.id = memory_source_receipts.canonical_memory_id
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_source_receipts.tenant_id
        AND m.id = memory_source_receipts.canonical_memory_id
    )
  );

CREATE POLICY memory_activation_reservations_scope_policy
  ON memory_activation_reservations
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_activation_reservations.tenant_id
        AND m.id = memory_activation_reservations.canonical_memory_id
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_activation_reservations.tenant_id
        AND m.id = memory_activation_reservations.canonical_memory_id
    )
  );

CREATE POLICY memory_erasure_reservations_scope_policy
  ON memory_erasure_reservations
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_erasure_reservations.tenant_id
        AND m.id = memory_erasure_reservations.canonical_memory_id
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_erasure_reservations.tenant_id
        AND m.id = memory_erasure_reservations.canonical_memory_id
    )
  );

CREATE POLICY raw_events_runtime_policy ON raw_events
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND repository_id = current_setting('app.repository_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND repository_id = current_setting('app.repository_id', true)
  );

CREATE POLICY personal_memory_preferences_subject_policy
  ON personal_memory_preferences
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
  );

CREATE POLICY memory_feedback_runtime_policy ON memory_feedback
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_feedback.tenant_id
        AND m.id = memory_feedback.memory_id
    )
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
    AND EXISTS (
      SELECT 1
      FROM memory_records m
      WHERE m.tenant_id = memory_feedback.tenant_id
        AND m.id = memory_feedback.memory_id
    )
  );

CREATE POLICY runtime_capability_replays_runtime_policy
  ON runtime_capability_replays
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND principal_id = current_setting('app.principal_id', true)
  );

CREATE INDEX memory_records_scope_active_idx
  ON memory_records (tenant_id, scope, scope_id, lifecycle_state, erasure_state);
CREATE INDEX raw_events_purge_idx ON raw_events (tenant_id, purge_at);
CREATE INDEX runtime_capability_replays_expiry_idx
  ON runtime_capability_replays (tenant_id, expires_at);

COMMIT;
