CREATE TABLE qwen_csi_resource_read (
    read_id VARCHAR(36) NOT NULL PRIMARY KEY,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    request_key CHAR(64) NOT NULL,
    binding_id VARCHAR(512) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    binding_version BIGINT NOT NULL,
    writer_id VARCHAR(512) NOT NULL,
    writer_generation BIGINT NOT NULL,
    writer_token_hash CHAR(64) NOT NULL,
    journal_revision BIGINT NOT NULL,
    activation_id VARCHAR(512),
    activation_epoch BIGINT NOT NULL,
    resource_id VARCHAR(512) NOT NULL,
    kind VARCHAR(512) NOT NULL,
    schema_version INT NOT NULL,
    byte_length BIGINT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    storage_kind VARCHAR(32) NOT NULL,
    resource_state VARCHAR(32) NOT NULL,
    state VARCHAR(16) NOT NULL,
    started_at BIGINT NOT NULL,
    delivery_expires_at BIGINT NOT NULL,
    ended_at BIGINT,
    outcome_code VARCHAR(128),
    CONSTRAINT csi_resource_read_state CHECK (state IN ('OPEN', 'RETURNED', 'UNKNOWN')),
    CONSTRAINT csi_resource_read_end CHECK (
        (state = 'RETURNED' AND ended_at IS NOT NULL)
        OR (state IN ('OPEN', 'UNKNOWN') AND ended_at IS NULL)
    ),
    INDEX csi_resource_read_binding (binding_id, runtime_generation, state, read_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
