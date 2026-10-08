CREATE TABLE IF NOT EXISTS qwen_runtime_placement_guard (
    tenant_key CHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(512) NOT NULL
);

CREATE TABLE IF NOT EXISTS qwen_runtime_binding_slot (
    request_key CHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    workspace_generation VARCHAR(512) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARCHAR(512) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    isolation_key VARCHAR(512),
    provisioner_kind VARCHAR(512) NOT NULL,
    storage_id VARCHAR(256),
    last_generation BIGINT NOT NULL,
    active_binding_id VARCHAR(512)
);

CREATE TABLE IF NOT EXISTS qwen_runtime_binding (
    binding_id VARCHAR(512) PRIMARY KEY,
    request_key CHAR(64) NOT NULL,
    scope_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    workspace_generation VARCHAR(512) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARCHAR(512) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    isolation_key VARCHAR(512),
    provisioner_kind VARCHAR(512) NOT NULL,
    storage_id VARCHAR(256),
    runtime_generation BIGINT NOT NULL,
    binding_state VARCHAR(32) NOT NULL,
    provision_request_id VARCHAR(512),
    provision_seed_ciphertext LONGTEXT,
    credential_key_id VARCHAR(512),
    resource_handle_version INT,
    resource_handle_json LONGTEXT,
    loss_evidence_json LONGTEXT,
    stop_evidence_json LONGTEXT,
    runtime_instance_id VARCHAR(512),
    runtime_endpoint VARCHAR(2048),
    runtime_lease_id VARCHAR(512),
    runtime_epoch BIGINT,
    runtime_credential_ciphertext LONGTEXT,
    runtime_credential_key_id VARCHAR(512),
    attestation_generation BIGINT NOT NULL,
    drain_requested BOOLEAN NOT NULL,
    operation_owner VARCHAR(512),
    operation_lease_until DATETIME(6),
    operation_generation BIGINT NOT NULL,
    record_version BIGINT NOT NULL,
    last_health_at DATETIME(6),
    last_reconciled_at DATETIME(6),
    last_active_at DATETIME(6) NOT NULL,
    CONSTRAINT uq_runtime_binding_generation
        UNIQUE (request_key, runtime_generation),
    INDEX idx_runtime_binding_scope
        (scope_key, isolation_key, binding_state),
    INDEX qwen_runtime_harness_bindings_idx (isolation_key, isolation_class),
    INDEX qwen_runtime_storage_bindings_idx (storage_id, binding_id)
);

CREATE TABLE IF NOT EXISTS managed_workspace_operator_recovery (
    recovery_id CHAR(36) PRIMARY KEY,
    binding_id VARCHAR(512) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    storage_key CHAR(64) NOT NULL,
    holder_key CHAR(64) NOT NULL,
    runtime_session_id VARCHAR(512) NOT NULL,
    provision_request_id VARCHAR(512) NOT NULL,
    resource_handle_json LONGTEXT NOT NULL,
    runtime_lease_id VARCHAR(512) NOT NULL,
    runtime_epoch BIGINT NOT NULL,
    blocked_execution_call_id VARCHAR(512) NOT NULL,
    operator_id VARCHAR(512) NOT NULL,
    reason VARCHAR(2048) NOT NULL,
    prepared_at DATETIME(6) NOT NULL,
    attestation_json LONGTEXT,
    attestation_sha256 CHAR(64),
    attested_at DATETIME(6),
    completed_at DATETIME(6),
    UNIQUE (binding_id, runtime_generation)
);

CREATE TABLE IF NOT EXISTS qwen_runtime_session (
    scope_key CHAR(64) NOT NULL,
    runtime_session_id VARCHAR(512) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    workspace_generation VARCHAR(512) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARCHAR(512) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    harness_session_id VARCHAR(512) NOT NULL,
    turn_kind VARCHAR(32) NOT NULL,
    binding_id VARCHAR(512) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    session_state VARCHAR(32) NOT NULL,
    record_version BIGINT NOT NULL,
    last_active_at DATETIME(6) NOT NULL,
    PRIMARY KEY (scope_key, runtime_session_id),
    INDEX idx_runtime_session_binding
        (binding_id, runtime_generation, session_state),
    INDEX idx_runtime_session_id (runtime_session_id)
);

CREATE TABLE IF NOT EXISTS qwen_tool_execution (
    execution_call_id_hash CHAR(64) PRIMARY KEY,
    execution_call_id VARCHAR(512) NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    idempotency_key VARCHAR(512) NOT NULL,
    binding_id VARCHAR(512) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    harness_session_id VARCHAR(512) NOT NULL,
    runtime_session_id VARCHAR(512) NOT NULL,
    runtime_session_key CHAR(64) NOT NULL,
    turn_id VARCHAR(512) NOT NULL,
    tool_call_id VARCHAR(512) NOT NULL,
    request_digest VARCHAR(512) NOT NULL,
    reference_json LONGTEXT NOT NULL,
    execution_state VARCHAR(32) NOT NULL,
    execution_status VARCHAR(32),
    result_json LONGTEXT,
    last_sequence BIGINT NOT NULL,
    cancel_requested BOOLEAN NOT NULL,
    dispatch_owner VARCHAR(512),
    dispatch_lease_until DATETIME(6),
    dispatch_generation BIGINT NOT NULL,
    record_version BIGINT NOT NULL,
    settled_at DATETIME(6),
    abandoned_at DATETIME(6),
    loss_evidence_id VARCHAR(512),
    authorized_dispatch_generation BIGINT,
    authorized_binding_version BIGINT,
    CONSTRAINT uq_tool_execution_idempotency
        UNIQUE (idempotency_key_hash),
    INDEX idx_tool_execution_session
        (runtime_session_key, execution_state),
    INDEX idx_tool_execution_binding
        (binding_id, runtime_generation, execution_state)
);

CREATE TABLE IF NOT EXISTS qwen_runtime_harness_drain (
    tenant_key VARCHAR(64) NOT NULL,
    harness_key VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    harness_session_id VARCHAR(512) NOT NULL,
    phase VARCHAR(32) NOT NULL DEFAULT 'DRAINING',
    operation_id VARCHAR(128),
    claim_generation BIGINT NOT NULL DEFAULT 0,
    claim_lease_until BIGINT,
    PRIMARY KEY (tenant_key, harness_key)
);

CREATE TABLE IF NOT EXISTS qwen_runtime_storage_fence (
    tenant_key VARCHAR(64) NOT NULL,
    storage_key VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    storage_id VARCHAR(512) NOT NULL,
    operation_id VARCHAR(36) NOT NULL,
    PRIMARY KEY (tenant_key, storage_key)
);
