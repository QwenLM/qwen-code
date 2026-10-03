CREATE TABLE qwen_runtime_harness_drain (
    tenant_key VARCHAR(64) NOT NULL,
    harness_key VARCHAR(64) NOT NULL,
    tenant_id VARCHAR(512) NOT NULL,
    harness_session_id VARCHAR(512) NOT NULL,
    PRIMARY KEY (tenant_key, harness_key)
);
ALTER TABLE qwen_runtime_binding ADD COLUMN drain_receipt_json LONGTEXT;
CREATE INDEX qwen_runtime_harness_bindings_idx
    ON qwen_runtime_binding (isolation_key, isolation_class);
