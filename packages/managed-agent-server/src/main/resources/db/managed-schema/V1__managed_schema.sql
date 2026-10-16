-- Fresh Managed Agent schema. This resource is the only baseline consumed by JDBC and Flyway.
-- No old-schema upgrade or compatibility objects are provided.

CREATE TABLE ma_session (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    agent_id VARBINARY(512),
    title VARCHAR(512),
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    harness_boot_id VARBINARY(144),
    harness_event_epoch VARBINARY(256),
    harness_last_event_id BIGINT NOT NULL DEFAULT 0,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id),
    public_session_id VARBINARY(512) GENERATED ALWAYS AS (CASE WHEN session_kind = 'PUBLIC' THEN session_id ELSE NULL END),
    UNIQUE (public_session_id),
    deleted_at BIGINT UNSIGNED,
    workspace_id VARBINARY(2048),
    workspace_generation BIGINT,
    workspace_storage_id VARBINARY(1024),
    cwd_relative VARCHAR(2048),
    context_config_ref VARBINARY(2048),
    context_revision BIGINT,
    workspace_config_ref VARBINARY(2048),
    workspace_policy_ref VARBINARY(2048),
    agent_revision VARCHAR(128) NOT NULL DEFAULT '1',
    approval_mode VARCHAR(32) NOT NULL DEFAULT 'yolo',
    tool_profile VARCHAR(64) DEFAULT 'hosted-workspace-files/1',
    creator_actor_key VARBINARY(2048) NULL,
    owner_actor_key VARBINARY(2048) NULL,
    parent_session_id VARBINARY(512) NULL,
    root_session_id VARBINARY(512) NULL,
    parent_child_run_id VARBINARY(2048) NULL,
    child_depth INT NULL,
    agent_definition_digest VARCHAR(64) NULL,
    session_kind VARCHAR(16) NOT NULL DEFAULT 'PUBLIC',
    tenant_key CHAR(64),
    session_key CHAR(64),
    session_scope_key CHAR(64),
    title_revision BIGINT NOT NULL DEFAULT 0,
    retirement_operation_id VARBINARY(512),
    retirement_generation BIGINT NOT NULL DEFAULT 0,
    retired_at BIGINT UNSIGNED,
    recovery_protected BOOLEAN NOT NULL DEFAULT FALSE,
    resource_gc_completed BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_ma_session_kind CHECK ((CASE session_kind WHEN 'PUBLIC' THEN 6 WHEN 'CONTROL' THEN 7 ELSE -1 END = CHAR_LENGTH(session_kind))),
    CONSTRAINT ck_ma_session_resource_gc CHECK (CASE resource_gc_completed WHEN FALSE THEN 1 WHEN TRUE THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_ma_public_agent CHECK (session_kind = 'CONTROL' OR agent_id IS NOT NULL),
    CONSTRAINT ck_ma_session_binding CHECK (session_kind = 'CONTROL' OR ((workspace_id IS NULL AND workspace_generation IS NULL AND workspace_storage_id IS NULL AND cwd_relative IS NULL AND context_config_ref IS NULL AND context_revision IS NULL AND workspace_config_ref IS NULL AND workspace_policy_ref IS NULL) OR (workspace_id IS NOT NULL AND workspace_generation IS NOT NULL AND workspace_generation > 0 AND workspace_storage_id IS NOT NULL AND cwd_relative IS NOT NULL AND context_config_ref IS NOT NULL AND context_revision IS NOT NULL AND context_revision > 0 AND workspace_config_ref IS NOT NULL AND workspace_policy_ref IS NOT NULL))),
    CONSTRAINT uq_ma_session_hash UNIQUE (tenant_key, session_key),
    CONSTRAINT uq_ma_session_scope UNIQUE (session_scope_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_session_list ON ma_session (tenant_id, gmt_modified, session_id);

CREATE INDEX ix_ma_session_retirement ON ma_session (retired_at, recovery_protected);

CREATE INDEX ix_ma_session_storage_scope ON ma_session (tenant_id, workspace_storage_id, resource_gc_completed, session_id);

CREATE TABLE ma_turn (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    turn_id VARBINARY(256) NOT NULL,
    prompt_id VARBINARY(144) NOT NULL,
    input_json LONGTEXT NOT NULL,
    payload_digest VARCHAR(71) NOT NULL,
    status VARCHAR(32) NOT NULL,
    submission_attempted BOOLEAN NOT NULL DEFAULT FALSE,
    harness_event_epoch VARBINARY(256),
    harness_last_event_id BIGINT,
    dispatch_owner VARBINARY(512),
    dispatch_lease_until BIGINT UNSIGNED,
    error_code VARCHAR(128),
    error_message VARCHAR(2048),
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    completed_at BIGINT UNSIGNED,
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id, turn_id),
    UNIQUE (prompt_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES ma_session (tenant_id, session_id),
    retry_count INT NOT NULL DEFAULT 0,
    consecutive_failures INT NOT NULL DEFAULT 0,
    budget_exempt_failures INT NOT NULL DEFAULT 0,
    retry_after BIGINT UNSIGNED
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_turn_dispatch ON ma_turn (status, dispatch_lease_until, gmt_modified);

CREATE TABLE ma_session_head (
    tenant_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048),
    session_id VARBINARY(2048) NOT NULL,
    storage_version INT,
    state VARCHAR(32),
    writer_generation BIGINT,
    writer_id VARBINARY(2048),
    writer_lease_until BIGINT UNSIGNED,
    lease_token_hash CHAR(64),
    journal_revision BIGINT,
    committed_sequence BIGINT,
    last_commit_digest CHAR(64),
    activation_epoch BIGINT,
    latest_checkpoint_resource_id VARBINARY(2048),
    compacted_through_revision BIGINT,
    recovery_status VARCHAR(32),
    recovery_detail_code VARCHAR(128),
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    o3_backfill_revision BIGINT NOT NULL DEFAULT 0,
    o3_backfill_through BIGINT,
    o3_backfill_error VARCHAR(128),
    o3_backfill_pending BOOLEAN NOT NULL DEFAULT TRUE,
    activation_id VARBINARY(2048),
    activation_phase VARCHAR(32),
    activation_event_epoch BIGINT,
    activation_expires_at BIGINT UNSIGNED,
    activation_head_revision BIGINT,
    tenant_key CHAR(64) NOT NULL,
    harness_key CHAR(64) NOT NULL,
    harness_session_id VARBINARY(2048) NOT NULL,
    head_kind VARCHAR(16) NOT NULL,
    phase VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    operation_id VARBINARY(512),
    claim_generation BIGINT NOT NULL DEFAULT 0,
    claim_lease_until BIGINT UNSIGNED,
    PRIMARY KEY (tenant_key, harness_key),
    CONSTRAINT ck_ma_head_kind CHECK ((CASE head_kind WHEN 'MANAGED_SESSION' THEN 15 WHEN 'HARNESS' THEN 7 ELSE -1 END = CHAR_LENGTH(head_kind))),
    CONSTRAINT ck_ma_head_journal CHECK ((head_kind = 'HARNESS' AND journal_revision IS NULL AND committed_sequence IS NULL AND writer_generation IS NULL AND activation_epoch IS NULL AND storage_version IS NULL) OR (head_kind = 'MANAGED_SESSION' AND journal_revision IS NOT NULL AND committed_sequence IS NOT NULL AND writer_generation IS NOT NULL AND activation_epoch IS NOT NULL AND storage_version IS NOT NULL)),
    CONSTRAINT ck_ma_head_counters CHECK (claim_generation >= 0 AND (writer_generation IS NULL OR writer_generation >= 0) AND (activation_epoch IS NULL OR activation_epoch >= 0))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_head_backfill ON ma_session_head (o3_backfill_pending, tenant_key, harness_key);

CREATE INDEX ix_ma_head_workspace ON ma_session_head (tenant_key, workspace_id, harness_key);

CREATE TABLE ma_session_journal_tx (
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    session_id VARBINARY(2048) NOT NULL,
    journal_revision BIGINT NOT NULL,
    command_key_hash CHAR(64) NOT NULL,
    transaction_id VARBINARY(2048) NOT NULL,
    operation LONGTEXT NOT NULL,
    command_id VARBINARY(2048) NOT NULL,
    content_digest CHAR(64) NOT NULL,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    event_count INT NOT NULL,
    events_digest CHAR(64),
    previous_commit_digest CHAR(64),
    commit_digest CHAR(64),
    writer_generation BIGINT NOT NULL,
    writer_id VARBINARY(2048) NOT NULL,
    writer_token_hash CHAR(64) NOT NULL,
    activation_epoch BIGINT NOT NULL,
    latest_checkpoint_resource_id VARBINARY(2048),
    record_encoding VARCHAR(32) NOT NULL,
    record_bytes MEDIUMBLOB NOT NULL,
    byte_length BIGINT NOT NULL,
    record_digest CHAR(64) NOT NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, session_id, journal_revision),
    CONSTRAINT uq_managed_session_command
        UNIQUE (tenant_id, session_id, command_key_hash)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_event_stream (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    stream_kind VARCHAR(16) NOT NULL,
    stream_id VARBINARY(512) NOT NULL,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    replay_floor_sequence BIGINT NOT NULL DEFAULT 0,
    covered_sequence BIGINT NOT NULL DEFAULT 0,
    wake_covered_sequence BIGINT,
    projection_version INT NOT NULL DEFAULT 1,
    snapshot_stale_since BIGINT UNSIGNED,
    current_snapshot_id VARBINARY(512),
    artifact_refs_resource_key CHAR(64),
    output_ranges_json LONGTEXT,
    projection_pending BOOLEAN GENERATED ALWAYS AS (last_sequence > covered_sequence OR snapshot_stale_since IS NOT NULL),
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, session_id, stream_kind, stream_id),
    CONSTRAINT ck_ma_stream_kind CHECK ((CASE stream_kind WHEN 'SESSION' THEN 7 WHEN 'TASK' THEN 4 ELSE -1 END = CHAR_LENGTH(stream_kind))),
    CONSTRAINT ck_ma_stream_counters CHECK (last_sequence >= 0 AND replay_floor_sequence >= 0 AND replay_floor_sequence <= last_sequence AND covered_sequence >= 0 AND covered_sequence <= last_sequence),
    CONSTRAINT ck_ma_stream_wake CHECK (wake_covered_sequence IS NULL OR (stream_kind = 'SESSION' AND wake_covered_sequence >= 0)),
    CONSTRAINT fk_ma_stream_session FOREIGN KEY (tenant_id, session_id) REFERENCES ma_session (tenant_id, session_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_stream_projection ON ma_event_stream (stream_kind, projection_pending, gmt_modified);

CREATE TABLE ma_public_event (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    sequence_id BIGINT NOT NULL,
    event_id VARBINARY(256) NOT NULL,
    turn_id VARBINARY(256),
    event_type VARCHAR(128) NOT NULL,
    data_json LONGTEXT,
    terminal BOOLEAN,
    source_key VARBINARY(1024),
    gmt_create BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, session_id, stream_kind, stream_id, sequence_id),
    UNIQUE (event_id),
    UNIQUE (tenant_id, session_id, stream_kind, stream_id, source_key),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES ma_session (tenant_id, session_id),
    schema_version INT NOT NULL DEFAULT 1,
    projection_version INT NOT NULL DEFAULT 1,
    item_id VARBINARY(512),
    content_part_id VARBINARY(512),
    stream_kind VARCHAR(16) NOT NULL DEFAULT 'SESSION',
    stream_id VARBINARY(512) NOT NULL DEFAULT '',
    state VARCHAR(32),
    runtime_state VARCHAR(32),
    text LONGTEXT,
    truncated BOOLEAN,
    artifact_id VARBINARY(512),
    capture_id VARBINARY(512),
    output_stream_id VARBINARY(512),
    first_ordinal BIGINT,
    end_ordinal BIGINT,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT ck_ma_event_session_payload CHECK (stream_kind = 'TASK' OR (data_json IS NOT NULL AND terminal IS NOT NULL)),
    CONSTRAINT ck_ma_event_stream CHECK ((CASE stream_kind WHEN 'SESSION' THEN 7 WHEN 'TASK' THEN 4 ELSE -1 END = CHAR_LENGTH(stream_kind))),
    CONSTRAINT fk_ma_event_stream FOREIGN KEY (tenant_id, session_id, stream_kind, stream_id) REFERENCES ma_event_stream (tenant_id, session_id, stream_kind, stream_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_event_turn ON ma_public_event (tenant_id, session_id, turn_id, sequence_id);

CREATE TABLE ma_message (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    item_id VARBINARY(512) NOT NULL,
    turn_id VARBINARY(256) NOT NULL,
    item_type VARCHAR(32) NOT NULL,
    item_role VARCHAR(32),
    item_status VARCHAR(32) NOT NULL,
    attributes_json LONGTEXT NOT NULL,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, session_id, item_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES ma_session (tenant_id, session_id) ,
    parts_json LONGTEXT NOT NULL,
    body_resource_key CHAR(64),
    execution_key CHAR(64),
    tool_call_key CHAR(64),
    policy_version VARBINARY(512),
    CONSTRAINT ck_ma_message_revision CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_message_history ON ma_message (tenant_id, session_id, first_sequence, item_id);

CREATE INDEX ix_ma_message_execution ON ma_message (execution_key, item_id);

CREATE TABLE ma_snapshot (
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512) NOT NULL,
    snapshot_id VARBINARY(512) NOT NULL,
    snapshot_version BIGINT NOT NULL,
    covered_sequence BIGINT NOT NULL,
    projection_version INT NOT NULL,
    manifest_resource_key CHAR(64) NOT NULL,
    manifest_sha256 CHAR(64) NOT NULL,
    item_count BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    published_at BIGINT UNSIGNED,
    retain_until BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, session_id, snapshot_id),
    CONSTRAINT uq_ma_snapshot_version UNIQUE (tenant_id, session_id, snapshot_version),
    CONSTRAINT ck_ma_snapshot_state CHECK ((CASE state WHEN 'BUILDING' THEN 8 WHEN 'PUBLISHED' THEN 9 WHEN 'RETIRED' THEN 7 ELSE -1 END = CHAR_LENGTH(state))),
    CONSTRAINT ck_ma_snapshot_revision CHECK (snapshot_version > 0 AND covered_sequence >= 0 AND item_count >= 0),
    CONSTRAINT fk_ma_snapshot_session FOREIGN KEY (tenant_id, session_id) REFERENCES ma_session (tenant_id, session_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_snapshot_expiry ON ma_snapshot (state, retain_until);

CREATE TABLE ma_session_record (
    session_scope_key CHAR(64) NOT NULL,
    record_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(2048),
    session_id VARBINARY(2048) NOT NULL,
    domain VARCHAR(64) NOT NULL,
    record_id VARBINARY(2048) NOT NULL,
    operation_hash CHAR(64),
    revision BIGINT NOT NULL,
    record_resource_id VARBINARY(2048),
    task_kind VARCHAR(32) NULL,
    task_state VARCHAR(32) NULL,
    runtime_state VARCHAR(32),
    definition_revision BIGINT,
    delivery_target VARCHAR(16),
    delivery_state VARCHAR(16),
    gmt_create BIGINT UNSIGNED NOT NULL,
    started_at BIGINT UNSIGNED,
    settled_at BIGINT UNSIGNED,
    PRIMARY KEY (session_scope_key, record_key),
    first_sequence BIGINT NOT NULL DEFAULT 0,
    hook_once_key_hash CHAR(64) NULL,
    hook_occurrence_hash CHAR(64) NULL,
    hook_ordinal BIGINT NULL,
    hook_definition_hash CHAR(64) NULL ,
    record_kind VARCHAR(16) NOT NULL DEFAULT 'DOMAIN',
    state VARCHAR(32),
    action_id VARBINARY(512),
    action_version BIGINT,
    decision_receipt_id VARBINARY(512),
    decision_digest CHAR(64),
    prompt_id VARBINARY(512),
    turn_id VARBINARY(512),
    options_json LONGTEXT,
    CONSTRAINT ck_ma_record_kind CHECK ((CASE record_kind WHEN 'DOMAIN' THEN 6 WHEN 'ACTION' THEN 6 ELSE -1 END = CHAR_LENGTH(record_kind))),
    CONSTRAINT ck_ma_record_role CHECK ((record_kind = 'DOMAIN' AND workspace_id IS NOT NULL AND record_resource_id IS NOT NULL) OR (record_kind = 'ACTION' AND action_id IS NOT NULL AND action_version IS NOT NULL AND options_json IS NOT NULL)),
    CONSTRAINT uq_ma_action_identity UNIQUE (session_scope_key, action_id),
    CONSTRAINT uq_ma_hook_once UNIQUE (session_scope_key, hook_once_key_hash),
    CONSTRAINT uq_ma_hook_occurrence UNIQUE (session_scope_key, hook_occurrence_hash, hook_ordinal)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_record_task ON ma_session_record (session_scope_key, gmt_create, record_key);

CREATE INDEX ix_ma_record_action ON ma_session_record (session_scope_key, record_kind, state, gmt_create, action_id);

CREATE INDEX ix_ma_record_operation ON ma_session_record (session_scope_key, operation_hash);

CREATE INDEX ix_ma_record_domain ON ma_session_record (domain, gmt_create, record_id);

CREATE INDEX ix_ma_record_delivery ON ma_session_record (domain, delivery_state, gmt_create);

CREATE INDEX ix_ma_record_session_delivery ON ma_session_record (session_scope_key, domain, delivery_state, gmt_create, record_key);

CREATE TABLE ma_agent_definition (
    tenant_id VARBINARY(512) NOT NULL,
    agent_id VARBINARY(512) NOT NULL,
    revision BIGINT NOT NULL,
    digest VARCHAR(64) NOT NULL,
    definition_json LONGTEXT NOT NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, agent_id, revision)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_resource (
    resource_key CHAR(64) NOT NULL,
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(2048),
    session_id VARBINARY(2048) NOT NULL,
    resource_id VARBINARY(2048) NOT NULL,
    kind VARBINARY(2048) NOT NULL,
    schema_version INT NOT NULL,
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    storage_kind VARCHAR(32) NOT NULL,
    inline_bytes LONGBLOB,
    object_key VARBINARY(8192),
    object_version_id VARBINARY(2048),
    encryption_key_id VARBINARY(2048),
    publish_command_id VARBINARY(2048),
    state VARCHAR(32) NOT NULL,
    snapshot_id VARBINARY(512),
    snapshot_page_ordinal INT,
    snapshot_page_first_sequence BIGINT,
    snapshot_page_last_sequence BIGINT,
    scope_key CHAR(64),
    publication_id VARBINARY(512),
    slot_key VARBINARY(1024),
    capture_state VARCHAR(32),
    capture_object_key VARBINARY(4096),
    operation_id VARBINARY(512),
    quarantine_reason VARCHAR(128),
    deletion_operation_key CHAR(64),
    gmt_create BIGINT UNSIGNED NOT NULL,
    last_verified_at BIGINT UNSIGNED,
    retention_until BIGINT UNSIGNED,
    PRIMARY KEY (resource_key),
    CONSTRAINT uq_ma_resource_id UNIQUE (session_scope_key, resource_id),
    CONSTRAINT uq_ma_capture_slot UNIQUE (scope_key, publication_id, slot_key),
    CONSTRAINT uq_ma_snapshot_page UNIQUE (session_scope_key, snapshot_id, snapshot_page_ordinal),
    CONSTRAINT ck_ma_resource_snapshot_page CHECK ((kind <> X'6d616e616765642d736e617073686f742d70616765' AND snapshot_id IS NULL AND snapshot_page_ordinal IS NULL AND snapshot_page_first_sequence IS NULL AND snapshot_page_last_sequence IS NULL) OR (snapshot_id IS NOT NULL AND snapshot_page_ordinal IS NOT NULL AND snapshot_page_ordinal >= 0 AND snapshot_page_first_sequence IS NOT NULL AND snapshot_page_first_sequence >= 0 AND snapshot_page_last_sequence IS NOT NULL AND snapshot_page_last_sequence >= snapshot_page_first_sequence AND kind = X'6d616e616765642d736e617073686f742d70616765' AND schema_version = 1 AND storage_kind = 'MYSQL_INLINE')),
    CONSTRAINT ck_ma_resource_length CHECK (byte_length >= 0),
    CONSTRAINT ck_ma_resource_capture CHECK ((publication_id IS NULL AND scope_key IS NULL AND slot_key IS NULL AND capture_state IS NULL) OR (publication_id IS NOT NULL AND scope_key IS NOT NULL AND slot_key IS NOT NULL AND capture_state IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_resource_gc ON ma_resource (session_scope_key, state, retention_until, resource_key);

CREATE INDEX ix_ma_resource_projection_gc ON ma_resource (retention_until, resource_key);

CREATE INDEX ix_ma_resource_capture ON ma_resource (scope_key, publication_id, capture_state);

CREATE INDEX ix_ma_resource_delete_intent ON ma_resource (session_scope_key, state, deletion_operation_key, resource_key);

CREATE INDEX ix_ma_snapshot_page_lookup ON ma_resource (session_scope_key, snapshot_id, snapshot_page_last_sequence, snapshot_page_ordinal);

CREATE TABLE ma_resource_ref (
    session_scope_key CHAR(64) NOT NULL,
    owner_kind VARCHAR(32) NOT NULL,
    owner_key CHAR(64) NOT NULL,
    owner_revision BIGINT NOT NULL,
    resource_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(2048),
    session_id VARBINARY(2048) NOT NULL,
    journal_revision BIGINT,
    resource_id VARBINARY(2048),
    gmt_create BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (session_scope_key, owner_kind, owner_key, owner_revision, resource_key),
    CONSTRAINT ck_ma_ref_owner CHECK ((CASE owner_kind WHEN 'JOURNAL' THEN 7 WHEN 'SNAPSHOT' THEN 8 WHEN 'CAPTURE' THEN 7 WHEN 'ARTIFACT' THEN 8 WHEN 'MESSAGE' THEN 7 WHEN 'SESSION_RECORD' THEN 14 WHEN 'EVENT_STREAM' THEN 12 WHEN 'OPERATION' THEN 9 WHEN 'OPERATION_WORK' THEN 14 WHEN 'RECOVERY' THEN 8 ELSE -1 END = CHAR_LENGTH(owner_kind))),
    CONSTRAINT fk_ma_ref_resource FOREIGN KEY (resource_key) REFERENCES ma_resource (resource_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_ref_resource ON ma_resource_ref (resource_key, session_scope_key);

CREATE INDEX ix_ma_ref_journal ON ma_resource_ref (session_scope_key, journal_revision, resource_id);

CREATE TABLE ma_output_capture (
    scope_key CHAR(64) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    session_id VARBINARY(2048) NOT NULL,
    publication_id VARBINARY(512) NOT NULL,
    execution_key CHAR(64) NOT NULL,
    capture_id VARBINARY(512) NOT NULL,
    binding_json MEDIUMTEXT NOT NULL,
    binding_digest CHAR(64) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    state VARCHAR(32) NOT NULL,
    expires_at BIGINT UNSIGNED,
    capture_bytes BIGINT NOT NULL,
    producer_bytes BIGINT NOT NULL,
    admission_bytes BIGINT NOT NULL,
    PRIMARY KEY (scope_key, publication_id),
    CONSTRAINT uq_tool_publication_execution UNIQUE (scope_key, execution_key),
    CONSTRAINT uq_tool_publication_capture UNIQUE (scope_key, capture_id),
    producer_phase VARCHAR(32) NOT NULL DEFAULT 'OPEN',
    quarantined BOOLEAN NOT NULL DEFAULT FALSE,
    active_operation_id VARBINARY(512),
    finish_operation_id VARBINARY(512),
    finish_predecessor_id VARBINARY(512),
    finish_digest CHAR(64),
    terminal_resource_id VARBINARY(512),
    admission_resource_id VARBINARY(512),
    receipt_sequence BIGINT,
    receipt_revision BIGINT,
    capture_held_bytes BIGINT NOT NULL DEFAULT 0,
    producer_held_bytes BIGINT NOT NULL DEFAULT 0,
    admission_held_bytes BIGINT NOT NULL DEFAULT 0,
    capture_used_bytes BIGINT NOT NULL DEFAULT 0,
    producer_used_bytes BIGINT NOT NULL DEFAULT 0,
    admission_used_bytes BIGINT NOT NULL DEFAULT 0,
    retention_state VARCHAR(32) NOT NULL DEFAULT 'PINNED',
    write_evidence BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_complete BOOLEAN NOT NULL DEFAULT FALSE,
    collected_at BIGINT UNSIGNED,
    collected_bytes BIGINT,
    released_held_bytes BIGINT ,
    manifest_resource_key CHAR(64),
    manifest_sha256 CHAR(64),
    seal_manifest_resource_key CHAR(64),
    seal_manifest_sha256 CHAR(64),
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT (CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000 + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000)),
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT (CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000 + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_capture_tenant ON ma_output_capture (tenant_key, state);

CREATE INDEX ix_ma_capture_retention ON ma_output_capture (retention_state);

CREATE INDEX ix_ma_capture_delete_intent ON ma_output_capture (scope_key, retention_state, publication_id);

CREATE INDEX ix_ma_capture_admission ON ma_output_capture (scope_key, admission_resource_id);

CREATE INDEX ix_ma_capture_session ON ma_output_capture (tenant_id, session_id);

CREATE TABLE ma_artifact (
    artifact_id VARBINARY(320) NOT NULL PRIMARY KEY,
    result_id VARBINARY(320) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    descriptor_json MEDIUMTEXT NOT NULL,
    publication_id VARBINARY(512) NOT NULL,
    binding_json MEDIUMTEXT NOT NULL,
    manifest_ref_json MEDIUMTEXT NOT NULL,
    stream_id VARBINARY(512) NOT NULL,
    creation_sequence BIGINT NOT NULL,
    CONSTRAINT uq_managed_artifact_stream UNIQUE (result_id, stream_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_artifact_page ON ma_artifact (scope_key, creation_sequence, artifact_id);

CREATE TABLE ma_request_receipt (
    receipt_key CHAR(64) NOT NULL,
    namespace VARCHAR(32) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    scope_kind VARCHAR(16) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    scope_id VARBINARY(2732) NOT NULL,
    idempotency_key VARBINARY(2048) NOT NULL,
    idempotency_digest CHAR(64) NOT NULL,
    request_digest VARCHAR(80) NOT NULL,
    actor_id VARBINARY(2048),
    operation VARCHAR(64),
    state VARCHAR(32) NOT NULL,
    workspace_bound BOOLEAN,
    session_id VARBINARY(512),
    turn_id VARBINARY(512),
    agent_id VARBINARY(512),
    agent_revision BIGINT,
    schedule_id VARBINARY(512),
    channel_id VARBINARY(512),
    account_generation BIGINT,
    semantic_revision BIGINT,
    action_id VARBINARY(512),
    action_version BIGINT,
    decision_scope_key CHAR(64) GENERATED ALWAYS AS (CASE WHEN namespace = 'ACTION_DECISION' THEN RTRIM(scope_key) ELSE NULL END),
    mutation_attempt_sequence BIGINT,
    session_status_before VARCHAR(32),
    result_operation_key CHAR(64),
    result_json LONGTEXT,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (receipt_key),
    CONSTRAINT uq_ma_decision_slot UNIQUE (tenant_key, decision_scope_key),
    CONSTRAINT uq_ma_request UNIQUE (namespace, tenant_key, scope_key, idempotency_digest),
    CONSTRAINT ck_ma_request_namespace CHECK ((CASE namespace WHEN 'SESSION_COMMAND' THEN 15 WHEN 'SESSION_CREATE_MODE' THEN 19 WHEN 'SESSION_CREATE_ACTOR' THEN 20 WHEN 'AGENT_DEFINITION' THEN 16 WHEN 'AUTOMATION' THEN 10 WHEN 'CHANNEL_INGRESS' THEN 15 WHEN 'ACTION_DECISION' THEN 15 ELSE -1 END = CHAR_LENGTH(namespace))),
    CONSTRAINT ck_ma_request_scope CHECK ((CASE scope_kind WHEN 'TENANT' THEN 6 WHEN 'ACTOR' THEN 5 WHEN 'SESSION' THEN 7 WHEN 'CHANNEL' THEN 7 ELSE -1 END = CHAR_LENGTH(scope_kind)))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_receipt_session ON ma_request_receipt (namespace, tenant_key, session_id);

CREATE INDEX ix_ma_receipt_channel ON ma_request_receipt (namespace, channel_id, account_generation, semantic_revision);

CREATE TABLE ma_operation (
    operation_key CHAR(64) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    session_scope_key CHAR(64),
    operation_id VARBINARY(2048) NOT NULL,
    operation_kind VARCHAR(48) NOT NULL,
    tenant_id VARBINARY(2048) NOT NULL,
    session_id VARBINARY(2048),
    workspace_id VARBINARY(2048),
    target_kind VARCHAR(32) NOT NULL,
    target_key CHAR(64) NOT NULL,
    target_revision BIGINT,
    target_id VARBINARY(2048),
    storage_key CHAR(64),
    physical_key CHAR(64),
    actor_key VARBINARY(2048),
    actor_id VARBINARY(2048),
    idempotency_key VARBINARY(2048),
    idempotency_digest CHAR(64),
    request_digest VARCHAR(80) NOT NULL,
    actor_digest VARCHAR(80),
    lifecycle_protocol_version INT,
    lifecycle_effects_receipt_json LONGTEXT,
    action_id VARBINARY(512),
    task_id VARBINARY(2048),
    decision_receipt_id VARBINARY(512),
    target_cwd_relative VARCHAR(2048),
    expected_context_revision BIGINT,
    result_context_revision BIGINT,
    payload_version INT NOT NULL DEFAULT 1,
    request_json LONGTEXT NOT NULL,
    result_json LONGTEXT,
    state VARCHAR(32) NOT NULL,
    phase VARCHAR(48) NOT NULL,
    admission_stage VARCHAR(32),
    delivery_state VARCHAR(32),
    session_status_before VARCHAR(32),
    receipt_id VARBINARY(512),
    claim_owner VARBINARY(512),
    claim_generation BIGINT NOT NULL DEFAULT 0,
    claim_until BIGINT UNSIGNED,
    available_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    attempt_count INT NOT NULL DEFAULT 0,
    budget_exempt_attempt INT NOT NULL DEFAULT 0,
    deadline BIGINT UNSIGNED,
    recovery_deadline BIGINT UNSIGNED,
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'SYNC',
    verification_request_json LONGTEXT,
    verification_ready BOOLEAN NOT NULL DEFAULT FALSE,
    verification_next_at BIGINT UNSIGNED,
    publication_id VARBINARY(512),
    publication_command_id VARBINARY(2048) GENERATED ALWAYS AS (CASE operation_kind WHEN 'OUTPUT_UPLOAD' THEN operation_id WHEN 'OUTPUT_VERIFY' THEN operation_id WHEN 'OUTPUT_FINISH' THEN operation_id ELSE NULL END),
    slot_key VARBINARY(1024),
    execution_key CHAR(64),
    item_id VARBINARY(512),
    policy_version VARBINARY(512),
    failure_status INT,
    failure_code VARCHAR(128),
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    completed_at BIGINT UNSIGNED,
    PRIMARY KEY (operation_key),
    CONSTRAINT uq_ma_operation_identity UNIQUE (scope_key, operation_kind, target_key, operation_id),
    CONSTRAINT uq_ma_publication_operation UNIQUE (scope_key, publication_id, publication_command_id),
    CONSTRAINT uq_ma_operation_public_request UNIQUE (scope_key, operation_kind, target_key, actor_digest, idempotency_digest),
    CONSTRAINT uq_ma_operation_request UNIQUE (scope_key, operation_kind, target_key, actor_key, idempotency_digest),
    CONSTRAINT ck_ma_operation_generation CHECK (claim_generation >= 0 AND attempt_count >= 0 AND payload_version > 0),
    CONSTRAINT ck_ma_operation_mode CHECK ((CASE execution_mode WHEN 'SYNC' THEN 4 WHEN 'ASYNC' THEN 5 ELSE -1 END = CHAR_LENGTH(execution_mode))),
    CONSTRAINT ck_ma_operation_kind CHECK ((CASE operation_kind WHEN 'CLOSE' THEN 5 WHEN 'ARCHIVE' THEN 7 WHEN 'DELETE' THEN 6 WHEN 'UNARCHIVE' THEN 9 WHEN 'RENAME' THEN 6 WHEN 'CWD_CHANGE' THEN 10 WHEN 'ACTION_RESPONSE' THEN 15 WHEN 'TASK_CANCEL' THEN 11 WHEN 'CHILD_SESSION_START' THEN 19 WHEN 'CHILD_SESSION_CLOSE' THEN 19 WHEN 'CHILD_WORKSPACE' THEN 15 WHEN 'OUTPUT_UPLOAD' THEN 13 WHEN 'OUTPUT_VERIFY' THEN 13 WHEN 'OUTPUT_FINISH' THEN 13 WHEN 'OBJECT_PUT' THEN 10 WHEN 'TOOL_RESULT_PROJECTION' THEN 22 WHEN 'SESSION_RESOURCE_GC' THEN 19 WHEN 'CAPTURE_GC' THEN 10 WHEN 'WORKSPACE_OPERATOR_RECOVERY' THEN 27 WHEN 'WORKSPACE_RECOVERY' THEN 18 WHEN 'STORAGE_MIGRATION' THEN 17 WHEN 'CSI_RETIREMENT' THEN 14 WHEN 'CHANNEL_INGRESS' THEN 15 ELSE -1 END = CHAR_LENGTH(operation_kind)))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_operation_due ON ma_operation (operation_kind, delivery_state, available_at);

CREATE INDEX ix_ma_operation_claim ON ma_operation (operation_kind, state, claim_until);

CREATE INDEX ix_ma_operation_target ON ma_operation (operation_kind, target_key, target_revision, state);

CREATE INDEX ix_ma_operation_storage ON ma_operation (storage_key, operation_kind, state);

CREATE INDEX ix_ma_operation_physical ON ma_operation (physical_key, operation_kind, state);

CREATE INDEX ix_ma_operation_verification ON ma_operation (operation_kind, execution_mode, state, verification_ready, verification_next_at);

CREATE INDEX ix_ma_operation_publication ON ma_operation (scope_key, publication_id, operation_kind, state);

CREATE INDEX ix_ma_operation_execution ON ma_operation (scope_key, operation_kind, execution_key);

CREATE INDEX ix_ma_operation_item ON ma_operation (scope_key, operation_kind, item_id);

CREATE TABLE ma_operation_work (
    operation_key CHAR(64) NOT NULL,
    work_kind VARCHAR(32) NOT NULL,
    target_key CHAR(64) NOT NULL,
    target_id VARBINARY(2048) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(512),
    storage_key CHAR(64),
    physical_key CHAR(64),
    state VARCHAR(32) NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    payload_version INT NOT NULL DEFAULT 1,
    payload_json LONGTEXT NOT NULL,
    evidence_resource_key CHAR(64),
    evidence_sha256 CHAR(64),
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (operation_key, work_kind, target_key),
    CONSTRAINT ck_ma_work_kind CHECK ((CASE work_kind WHEN 'SESSION' THEN 7 WHEN 'RESOURCE' THEN 8 WHEN 'EXECUTION_ACK' THEN 13 WHEN 'RUNTIME_BINDING' THEN 15 WHEN 'CSI_WORKER_ACK' THEN 14 WHEN 'RECOVERY_EVIDENCE' THEN 17 ELSE -1 END = CHAR_LENGTH(work_kind))),
    CONSTRAINT fk_ma_work_operation FOREIGN KEY (operation_key) REFERENCES ma_operation (operation_key),
    CONSTRAINT fk_ma_work_evidence FOREIGN KEY (evidence_resource_key) REFERENCES ma_resource (resource_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_work_session ON ma_operation_work (tenant_id, session_id, work_kind, state);

CREATE INDEX ix_ma_work_storage ON ma_operation_work (storage_key, work_kind, state);

CREATE INDEX ix_ma_work_physical ON ma_operation_work (physical_key, work_kind, state);

CREATE TABLE ma_workspace (
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(512) NOT NULL,
    workspace_generation BIGINT NOT NULL,
    storage_id VARBINARY(1024) NOT NULL,
    display_name VARCHAR(512) NOT NULL,
    config_ref VARBINARY(2048) NOT NULL,
    policy_ref VARBINARY(2048) NOT NULL,
    state VARCHAR(16) NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id),
    CONSTRAINT ck_ma_workspace_generation CHECK (workspace_generation > 0),
    CONSTRAINT ck_ma_workspace_state CHECK ((CASE state WHEN 'ACTIVE' THEN 6 WHEN 'DRAINING' THEN 8 WHEN 'REMOVED' THEN 7 ELSE -1 END = CHAR_LENGTH(state))),
    workspace_kind VARCHAR(16) NOT NULL DEFAULT 'ROOT',
    child_state VARCHAR(32),
    parent_workspace_id VARBINARY(512),
    parent_session_id VARBINARY(512),
    child_run_id VARBINARY(2048),
    child_workspace_id VARBINARY(128),
    parent_cwd_relative VARCHAR(2048),
    repository_relative VARCHAR(2048),
    child_cwd_relative VARCHAR(2048),
    base_commit VARCHAR(64),
    result_commit VARCHAR(64),
    parent_tree VARCHAR(64),
    merged_tree VARCHAR(64),
    finish_request VARCHAR(16),
    outcome_code VARCHAR(64),
    conflict_paths LONGTEXT,
    last_error VARCHAR(1024),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    default_tenant VARBINARY(512) GENERATED ALWAYS AS (CASE WHEN is_default THEN tenant_id ELSE NULL END),
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT 0,
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT uq_ma_workspace_default UNIQUE (default_tenant),
    CONSTRAINT uq_ma_workspace_child UNIQUE (tenant_id, parent_session_id, child_run_id),
    CONSTRAINT uq_ma_child_workspace_id UNIQUE (child_workspace_id),
    CONSTRAINT ck_ma_workspace_kind CHECK ((CASE workspace_kind WHEN 'ROOT' THEN 4 WHEN 'CHILD_GIT' THEN 9 ELSE -1 END = CHAR_LENGTH(workspace_kind))),
    CONSTRAINT ck_ma_workspace_default CHECK (is_default = 0 OR workspace_kind = 'ROOT')
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_workspace_storage ON ma_workspace (tenant_id, storage_id, state);

CREATE TABLE ma_workspace_access (
    tenant_id VARBINARY(512) NOT NULL,
    workspace_id VARBINARY(512) NOT NULL,
    actor_id VARBINARY(2048) NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES ma_workspace (tenant_id, workspace_id),
    role VARCHAR(16) NOT NULL,
    CONSTRAINT ck_ma_access_role CHECK (CASE role WHEN 'READER' THEN 6 WHEN 'OPERATOR' THEN 8 WHEN 'OWNER' THEN 5 ELSE -1 END = CHAR_LENGTH(role))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_storage (
    alias_key CHAR(64) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    storage_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(2048) NOT NULL,
    storage_id VARBINARY(2048) NOT NULL,
    physical_key CHAR(64),
    registration_state VARCHAR(16) NOT NULL DEFAULT 'FENCE_ONLY',
    storage_kind VARCHAR(16) NOT NULL DEFAULT 'UNREGISTERED',
    registration_revision BIGINT,
    registration_json LONGTEXT,
    fence_operation_id VARBINARY(512),
    mount_revision BIGINT NOT NULL DEFAULT 0,
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT 0,
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (alias_key),
    CONSTRAINT uq_ma_storage_alias UNIQUE (tenant_key, storage_key),
    CONSTRAINT ck_ma_storage_registration CHECK ((CASE registration_state WHEN 'FENCE_ONLY' THEN 10 WHEN 'REGISTERED' THEN 10 WHEN 'RETIRING' THEN 8 WHEN 'RETIRED' THEN 7 ELSE -1 END = CHAR_LENGTH(registration_state))),
    CONSTRAINT ck_ma_storage_registered CHECK (registration_state = 'FENCE_ONLY' OR (physical_key IS NOT NULL AND registration_revision IS NOT NULL AND registration_json IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_storage_physical ON ma_storage (physical_key);

CREATE TABLE ma_runtime_slot (
    request_key CHAR(64) PRIMARY KEY,
    tenant_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    workspace_generation VARBINARY(2048) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARBINARY(2048) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    isolation_key VARBINARY(2048),
    provisioner_kind VARCHAR(512) NOT NULL,
    storage_id VARBINARY(1024),
    last_generation BIGINT NOT NULL,
    active_binding_id VARBINARY(2048)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_runtime_binding (
    binding_id VARBINARY(2048) PRIMARY KEY,
    request_key CHAR(64) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    workspace_generation VARBINARY(2048) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARBINARY(2048) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    isolation_key VARBINARY(2048),
    provisioner_kind VARCHAR(512) NOT NULL,
    storage_id VARBINARY(1024),
    storage_alias_key CHAR(64),
    runtime_generation BIGINT NOT NULL,
    binding_state VARCHAR(32) NOT NULL,
    provision_request_id VARBINARY(2048),
    provision_seed_ciphertext LONGTEXT,
    provision_seeded BOOLEAN GENERATED ALWAYS AS (provision_seed_ciphertext IS NOT NULL),
    credential_key_id VARBINARY(2048),
    resource_handle_version INT,
    resource_handle_json LONGTEXT,
    loss_evidence_json LONGTEXT,
    stop_evidence_json LONGTEXT,
    runtime_instance_id VARBINARY(2048),
    runtime_endpoint VARCHAR(2048),
    runtime_lease_id VARBINARY(2048),
    runtime_epoch BIGINT,
    runtime_credential_ciphertext LONGTEXT,
    runtime_credential_key_id VARBINARY(2048),
    attestation_generation BIGINT NOT NULL,
    drain_requested BOOLEAN NOT NULL,
    operation_owner VARBINARY(2048),
    operation_lease_until BIGINT UNSIGNED,
    operation_generation BIGINT NOT NULL,
    record_version BIGINT NOT NULL,
    last_health_at BIGINT UNSIGNED,
    last_reconciled_at BIGINT UNSIGNED,
    last_active_at BIGINT UNSIGNED NOT NULL,
    CONSTRAINT uq_runtime_binding_generation
        UNIQUE (request_key, runtime_generation),
    INDEX idx_runtime_binding_scope
        (scope_key, isolation_key, binding_state),
    INDEX qwen_runtime_harness_bindings_idx (isolation_key, isolation_class),
    INDEX qwen_runtime_storage_bindings_idx (storage_id, binding_id),
    drain_receipt_json LONGTEXT
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_runtime_storage_alias_state ON ma_runtime_binding (storage_alias_key, binding_state, provision_seeded, binding_id);

CREATE TABLE ma_runtime_session (
    scope_key CHAR(64) NOT NULL,
    runtime_session_id VARBINARY(2048) NOT NULL,
    tenant_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    workspace_generation VARBINARY(2048) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARBINARY(2048) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    harness_session_id VARBINARY(2048) NOT NULL,
    turn_kind VARCHAR(32) NOT NULL,
    binding_id VARBINARY(2048) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    session_state VARCHAR(32) NOT NULL,
    record_version BIGINT NOT NULL,
    last_active_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (scope_key, runtime_session_id),
    INDEX idx_runtime_session_binding
        (binding_id, runtime_generation, session_state),
    INDEX idx_runtime_session_id (runtime_session_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_tool_execution (
    execution_call_id_hash CHAR(64) PRIMARY KEY,
    execution_call_id VARBINARY(2048) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    idempotency_key VARBINARY(2048) NOT NULL,
    binding_id VARBINARY(2048) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    harness_session_id VARBINARY(2048) NOT NULL,
    runtime_session_id VARBINARY(2048) NOT NULL,
    runtime_session_key CHAR(64) NOT NULL,
    turn_id VARBINARY(2048) NOT NULL,
    tool_call_id VARBINARY(2048) NOT NULL,
    request_digest VARCHAR(512) NOT NULL,
    reference_json LONGTEXT NOT NULL,
    execution_state VARCHAR(32) NOT NULL,
    execution_status VARCHAR(32),
    result_json LONGTEXT,
    last_sequence BIGINT NOT NULL,
    cancel_requested BOOLEAN NOT NULL,
    dispatch_owner VARBINARY(2048),
    dispatch_lease_until BIGINT UNSIGNED,
    dispatch_generation BIGINT NOT NULL,
    record_version BIGINT NOT NULL,
    settled_at BIGINT UNSIGNED,
    abandoned_at BIGINT UNSIGNED,
    loss_evidence_id VARBINARY(2048),
    authorized_dispatch_generation BIGINT,
    authorized_binding_version BIGINT,
    CONSTRAINT uq_tool_execution_idempotency
        UNIQUE (idempotency_key_hash),
    INDEX idx_tool_execution_session
        (runtime_session_key, execution_state),
    INDEX idx_tool_execution_binding
        (binding_id, runtime_generation, execution_state),
    INDEX idx_tool_execution_harness
        (harness_session_id, execution_call_id_hash)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_storage_owner (
    storage_key CHAR(64) PRIMARY KEY,
    holder_key CHAR(64),
    binding_id VARBINARY(2048),
    runtime_generation BIGINT,
    runtime_session_id VARBINARY(2048),
    tenant_id VARBINARY(1024),
    storage_id VARBINARY(1024),
    mount_revision BIGINT NOT NULL DEFAULT 0,
    mount_state VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED',
    mount_operation_id CHAR(36),
    mount_completed_operation_id CHAR(36),
    mount_root VARCHAR(2048),
    mount_host_id VARCHAR(256),
    mount_device VARCHAR(32),
    mount_inode VARCHAR(32),
    mount_birth_time VARCHAR(64),
    mount_registration_id CHAR(36),
    storage_kind VARCHAR(16) NOT NULL DEFAULT 'LOCAL',
    csi_phase VARCHAR(16) NOT NULL DEFAULT 'RELEASED',
    csi_revision BIGINT NOT NULL DEFAULT 0,
    csi_reservation_id CHAR(36),
    csi_registration_key CHAR(64),
    csi_registration_revision BIGINT,
    csi_provision_request_id VARBINARY(2048),
    maintenance_id CHAR(32),
    maintenance_generation BIGINT,
    INDEX idx_execution_lease_maintenance (maintenance_id),
    physical_key CHAR(64),
    CONSTRAINT uq_ma_storage_owner_physical UNIQUE (physical_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_storage_owner_binding ON ma_storage_owner (binding_id, runtime_generation, storage_key);

CREATE TABLE ma_tenant_guard (
    tenant_key CHAR(64) NOT NULL,
    tenant_id VARBINARY(2048) NOT NULL,
    guard_domain VARCHAR(32) NOT NULL,
    PRIMARY KEY (tenant_key, guard_domain),
    CONSTRAINT ck_ma_guard_domain CHECK ((CASE guard_domain WHEN 'runtime_placement' THEN 17 WHEN 'output_publication' THEN 18 ELSE -1 END = CHAR_LENGTH(guard_domain)))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_read_lease (
    lease_id VARBINARY(144) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    session_key CHAR(64) NOT NULL,
    retirement_generation BIGINT NOT NULL,
    expires_at BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (lease_id),
    CONSTRAINT ck_ma_read_generation CHECK (retirement_generation >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_read_session ON ma_read_lease (tenant_key, session_key, expires_at);

CREATE TABLE ma_channel_instance (
    tenant_id VARBINARY(512) NOT NULL,
    channel_id VARBINARY(512) NOT NULL,
    platform VARCHAR(64) NOT NULL,
    account_id VARBINARY(2048) NOT NULL,
    account_generation BIGINT NOT NULL,
    state VARCHAR(16) NOT NULL,
    actor_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    cwd_relative VARCHAR(1024) NOT NULL,
    policy_json LONGTEXT NOT NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, channel_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_channel_binding (
    tenant_id VARBINARY(512) NOT NULL,
    channel_id VARBINARY(512) NOT NULL,
    route_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(2048) NOT NULL,
    scope_kind VARCHAR(16) NOT NULL,
    sender_id VARBINARY(2048),
    chat_id VARBINARY(2048),
    thread_id VARBINARY(2048),
    gmt_create BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, channel_id, route_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_channel_created ON ma_channel_instance (tenant_id, gmt_create, channel_id);

CREATE INDEX ix_ma_channel_binding_session ON ma_channel_binding (tenant_id, session_id);

CREATE TABLE ma_delivery (
    delivery_key CHAR(64) NOT NULL,
    delivery_kind VARCHAR(32) NOT NULL,
    tenant_id VARBINARY(512) NOT NULL,
    channel_id VARBINARY(512),
    delivery_id VARBINARY(2048) NOT NULL,
    source_session_id VARBINARY(512),
    target_session_id VARBINARY(512),
    source_scope_key CHAR(64) NOT NULL,
    source_record_key CHAR(64),
    source_revision BIGINT,
    segment_id VARBINARY(512),
    segment_ordinal BIGINT,
    creation_key VARBINARY(2048),
    provider_id VARBINARY(2048),
    provider_receipt_json LONGTEXT,
    request_digest CHAR(64),
    payload_version INT NOT NULL DEFAULT 1,
    payload_json LONGTEXT NOT NULL,
    transport_state VARCHAR(32) NOT NULL,
    reception_state VARCHAR(32) NOT NULL,
    consumption_state VARCHAR(32) NOT NULL,
    claimed_at BIGINT UNSIGNED,
    reconcile_operation_id VARBINARY(512),
    claim_owner VARBINARY(512),
    claim_generation BIGINT NOT NULL DEFAULT 0,
    claim_until BIGINT UNSIGNED,
    attempt_count INT NOT NULL DEFAULT 0,
    available_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(2048),
    failure_code VARCHAR(128),
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (delivery_key),
    CONSTRAINT uq_ma_delivery_identity UNIQUE (delivery_kind, source_scope_key, delivery_id),
    CONSTRAINT ck_ma_delivery_kind CHECK ((CASE delivery_kind WHEN 'CHANNEL' THEN 7 WHEN 'SESSION_MESSAGE' THEN 15 WHEN 'CHILD_RESULT' THEN 12 ELSE -1 END = CHAR_LENGTH(delivery_kind))),
    CONSTRAINT ck_ma_delivery_source CHECK (delivery_kind = 'CHANNEL' OR source_session_id IS NOT NULL),
    CONSTRAINT ck_ma_delivery_claim_source CHECK (claimed_at IS NULL OR source_session_id IS NOT NULL),
    CONSTRAINT ck_ma_delivery_generation CHECK (claim_generation >= 0 AND attempt_count >= 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_delivery_poll ON ma_delivery (delivery_kind, transport_state, available_at);

CREATE INDEX ix_ma_delivery_claim ON ma_delivery (delivery_kind, claim_until);

CREATE INDEX ix_ma_delivery_channel ON ma_delivery (tenant_id, channel_id, claimed_at);

CREATE INDEX ix_ma_delivery_session ON ma_delivery (source_scope_key, delivery_kind, consumption_state);

CREATE TABLE ma_schedule (
    tenant_id VARBINARY(512) NOT NULL,
    schedule_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(2048) NOT NULL,
    workspace_id VARBINARY(2048) NOT NULL,
    actor_id VARBINARY(2048) NOT NULL,
    record_revision BIGINT NOT NULL,
    definition_revision BIGINT NOT NULL,
    definition_digest CHAR(64) NOT NULL,
    goal VARCHAR(4096) NOT NULL,
    cron VARCHAR(4096) NOT NULL,
    timezone VARCHAR(256) NOT NULL,
    session_mode VARCHAR(16) NOT NULL,
    overlap VARCHAR(16) NOT NULL,
    catch_up VARCHAR(16) NOT NULL,
    catch_up_limit BIGINT NULL,
    enabled BOOLEAN NOT NULL,
    state VARCHAR(16) NOT NULL,
    blocked_reason VARCHAR(1024) NULL,
    armed_at BIGINT UNSIGNED NOT NULL,
    watermark_slot BIGINT UNSIGNED NULL,
    lease_owner VARBINARY(512) NULL,
    lease_until BIGINT UNSIGNED NULL,
    fence BIGINT NOT NULL DEFAULT 0,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, schedule_id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE ma_schedule_occurrence (
    tenant_id VARBINARY(512) NOT NULL,
    schedule_id VARBINARY(512) NOT NULL,
    occurrence_key VARBINARY(640) NOT NULL,
    run_id VARBINARY(512) NOT NULL,
    session_id VARBINARY(2048) NOT NULL,
    slot BIGINT UNSIGNED NULL,
    trigger_kind VARCHAR(16) NOT NULL,
    outcome VARCHAR(16) NOT NULL,
    reason VARCHAR(64) NULL,
    definition_revision BIGINT NOT NULL,
    fence BIGINT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(1024) NULL,
    gmt_create BIGINT UNSIGNED NOT NULL,
    gmt_modified BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (tenant_id, schedule_id, occurrence_key)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX ix_ma_schedule_scan ON ma_schedule (state, enabled, lease_until);

CREATE INDEX ix_ma_schedule_list ON ma_schedule (tenant_id, gmt_create, schedule_id);

CREATE INDEX ix_ma_schedule_session ON ma_schedule (tenant_id, session_id);

CREATE INDEX ix_ma_occurrence_list ON ma_schedule_occurrence (tenant_id, schedule_id, gmt_create, occurrence_key);

CREATE INDEX ix_ma_occurrence_outcome ON ma_schedule_occurrence (tenant_id, schedule_id, outcome);

ALTER TABLE ma_snapshot ADD CONSTRAINT fk_ma_snapshot_manifest_resource_key FOREIGN KEY (manifest_resource_key) REFERENCES ma_resource (resource_key);

ALTER TABLE ma_message ADD CONSTRAINT fk_ma_message_body_resource_key FOREIGN KEY (body_resource_key) REFERENCES ma_resource (resource_key);

ALTER TABLE ma_output_capture ADD CONSTRAINT fk_ma_output_capture_manifest_resource_key FOREIGN KEY (manifest_resource_key) REFERENCES ma_resource (resource_key);

ALTER TABLE ma_output_capture ADD CONSTRAINT fk_ma_output_capture_seal_manifest_resource_key FOREIGN KEY (seal_manifest_resource_key) REFERENCES ma_resource (resource_key);

CREATE INDEX ix_ma_work_page ON ma_operation_work (operation_key, work_kind, target_key);

CREATE INDEX ix_ma_work_session_page ON ma_operation_work (operation_key, work_kind, session_id);

CREATE INDEX ix_ma_work_pending ON ma_operation_work (operation_key, work_kind, session_id, state, target_key);

CREATE INDEX ix_ma_operation_target_raw ON ma_operation (operation_kind, target_id, target_revision, state);

CREATE INDEX ix_ma_operation_raw_id ON ma_operation (operation_kind, operation_id);

CREATE INDEX ix_ma_channel_delivery_page ON ma_delivery (delivery_kind, source_scope_key, gmt_create, delivery_id);

CREATE INDEX ix_ma_channel_delivery_expiry ON ma_delivery (delivery_kind, transport_state, claimed_at, delivery_id);

CREATE INDEX ix_ma_receipt_ingress_lookup ON ma_request_receipt (namespace, tenant_key, idempotency_digest);

CREATE INDEX ix_ma_receipt_ingress_page ON ma_request_receipt (namespace, tenant_key, channel_id, gmt_create, idempotency_key);

CREATE INDEX ix_ma_operation_state_due ON ma_operation (operation_kind, state, available_at, operation_key);

CREATE INDEX ix_ma_operation_scope_id ON ma_operation (scope_key, operation_kind, operation_id);

CREATE INDEX ix_ma_operation_session_state ON ma_operation (session_scope_key, operation_kind, state);

CREATE INDEX ix_ma_resource_scope_page ON ma_resource (session_scope_key, resource_key);

CREATE INDEX ix_ma_snapshot_session_expiry ON ma_snapshot (tenant_id, session_id, retain_until, snapshot_id);

ALTER TABLE ma_event_stream ADD CONSTRAINT fk_ma_stream_snapshot FOREIGN KEY (tenant_id, session_id, current_snapshot_id) REFERENCES ma_snapshot (tenant_id, session_id, snapshot_id);

ALTER TABLE ma_event_stream ADD CONSTRAINT fk_ma_stream_artifact_refs FOREIGN KEY (artifact_refs_resource_key) REFERENCES ma_resource (resource_key);

CREATE UNIQUE INDEX uq_ma_delivery_reconciliation ON ma_delivery (reconcile_operation_id);

CREATE INDEX ix_ma_operation_gc_due ON ma_operation (operation_kind, available_at, operation_key);

CREATE INDEX ix_ma_operation_result_due ON ma_operation (operation_kind, state, available_at, operation_id);

CREATE INDEX ix_ma_operation_result_lease ON ma_operation (operation_kind, state, claim_until, operation_id);

CREATE INDEX ix_ma_hook_definition ON ma_session_record (session_scope_key, hook_definition_hash, record_kind);


-- Runtime history cleanup uses these predicates without scanning active families.
CREATE INDEX ix_ma_runtime_retention ON ma_runtime_binding (binding_state, last_active_at, binding_id);

CREATE INDEX ix_ma_runtime_tenant_state ON ma_runtime_binding (tenant_id, binding_state);

CREATE INDEX ix_ma_capture_execution ON ma_output_capture (execution_key);

CREATE INDEX ix_ma_work_execution ON ma_operation_work (work_kind, target_key, operation_key);
