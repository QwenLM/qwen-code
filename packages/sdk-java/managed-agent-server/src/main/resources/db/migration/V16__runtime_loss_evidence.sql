CREATE TABLE qwen_runtime_placement_guard (
    tenant_key CHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(512) NOT NULL
);

ALTER TABLE qwen_runtime_binding
    ADD COLUMN loss_evidence_json LONGTEXT;

ALTER TABLE qwen_runtime_binding
    ADD COLUMN stop_evidence_json LONGTEXT;

ALTER TABLE qwen_tool_execution
    ADD COLUMN abandoned_at DATETIME(6);

ALTER TABLE qwen_tool_execution
    ADD COLUMN loss_evidence_id VARCHAR(512);
