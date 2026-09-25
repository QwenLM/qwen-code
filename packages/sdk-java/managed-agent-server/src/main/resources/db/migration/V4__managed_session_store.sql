CREATE TABLE qwen_managed_session_journal_head (
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    storage_version INT NOT NULL,
    state VARCHAR(32) NOT NULL,
    writer_generation BIGINT NOT NULL,
    writer_id VARCHAR(512),
    writer_lease_until DATETIME(6),
    lease_token_hash CHAR(64),
    journal_revision BIGINT NOT NULL,
    committed_sequence BIGINT NOT NULL,
    last_commit_digest CHAR(64),
    activation_epoch BIGINT NOT NULL,
    latest_checkpoint_resource_id VARCHAR(512),
    compacted_through_revision BIGINT NOT NULL,
    recovery_status VARCHAR(32) NOT NULL,
    recovery_detail_code VARCHAR(128),
    created_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, session_id)
);

CREATE TABLE qwen_managed_session_journal_tx (
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    journal_revision BIGINT NOT NULL,
    command_key_hash CHAR(64) NOT NULL,
    transaction_id VARCHAR(512) NOT NULL,
    operation LONGTEXT NOT NULL,
    command_id VARCHAR(512) NOT NULL,
    content_digest CHAR(64) NOT NULL,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    event_count INT NOT NULL,
    events_digest CHAR(64),
    previous_commit_digest CHAR(64),
    commit_digest CHAR(64),
    writer_generation BIGINT NOT NULL,
    writer_id VARCHAR(512) NOT NULL,
    writer_token_hash CHAR(64) NOT NULL,
    activation_epoch BIGINT NOT NULL,
    latest_checkpoint_resource_id VARCHAR(512),
    record_encoding VARCHAR(32) NOT NULL,
    record_bytes MEDIUMBLOB NOT NULL,
    byte_length BIGINT NOT NULL,
    record_digest CHAR(64) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (tenant_id, session_id, journal_revision),
    CONSTRAINT uq_managed_session_command
        UNIQUE (tenant_id, session_id, command_key_hash)
);

CREATE TABLE qwen_managed_session_resource (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    resource_id VARCHAR(512) NOT NULL,
    kind VARCHAR(512) NOT NULL,
    schema_version INT NOT NULL,
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    storage_kind VARCHAR(32) NOT NULL,
    inline_bytes MEDIUMBLOB,
    object_key VARCHAR(2048),
    object_version_id VARCHAR(512),
    encryption_key_id VARCHAR(512),
    publish_command_id VARCHAR(512) NOT NULL,
    state VARCHAR(32) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    last_verified_at DATETIME(6),
    retention_until DATETIME(6),
    PRIMARY KEY (session_scope_key, resource_id)
);

CREATE TABLE qwen_managed_session_resource_ref (
    session_scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    journal_revision BIGINT NOT NULL,
    resource_id VARCHAR(512) NOT NULL,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (session_scope_key, journal_revision, resource_id)
);

CREATE INDEX idx_managed_session_resource_ref_resource
    ON qwen_managed_session_resource_ref (session_scope_key, resource_id);
