CREATE TABLE IF NOT EXISTS qwen_runtime_binding_slot (
    request_key CHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(512) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    workspace_generation VARCHAR(512) NOT NULL,
    canonical_cwd VARCHAR(512) NOT NULL,
    capability_digest VARCHAR(512) NOT NULL,
    isolation_class VARCHAR(32) NOT NULL,
    isolation_key VARCHAR(512),
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
    runtime_generation BIGINT NOT NULL,
    binding_state VARCHAR(32) NOT NULL,
    runtime_instance_id VARCHAR(512),
    runtime_endpoint VARCHAR(2048),
    runtime_token VARCHAR(512),
    runtime_lease_id VARCHAR(512),
    runtime_epoch BIGINT,
    drain_requested BOOLEAN NOT NULL,
    operation_owner VARCHAR(512),
    operation_lease_until DATETIME(6),
    operation_generation BIGINT NOT NULL,
    record_version BIGINT NOT NULL,
    last_health_at DATETIME(6),
    last_active_at DATETIME(6) NOT NULL,
    CONSTRAINT uq_runtime_binding_generation
        UNIQUE (request_key, runtime_generation),
    INDEX idx_runtime_binding_scope
        (scope_key, isolation_key, binding_state)
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
        (binding_id, runtime_generation, session_state)
);
