CREATE TABLE IF NOT EXISTS qwen_runtime_storage_fence (
    tenant_key VARCHAR(64) NOT NULL,
    storage_key VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    storage_id VARCHAR(512) NOT NULL,
    operation_id VARCHAR(36) NOT NULL,
    PRIMARY KEY (tenant_key, storage_key)
);

CREATE TABLE managed_workspace_migration (
    operation_id VARCHAR(36) PRIMARY KEY,
    tenant_id VARCHAR(128) NOT NULL,
    storage_id VARCHAR(256) NOT NULL,
    request_digest VARCHAR(64) NOT NULL,
    request_json LONGTEXT NOT NULL,
    state VARCHAR(32) NOT NULL,
    source_registration_json LONGTEXT,
    target_identity_json LONGTEXT,
    history_identity_json LONGTEXT,
    target_registration_id VARCHAR(36) NOT NULL,
    verify_operation_id VARCHAR(36),
    last_error_code VARCHAR(64),
    result_json LONGTEXT,
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX qwen_runtime_storage_bindings_idx ON qwen_runtime_binding (storage_id, binding_id);
