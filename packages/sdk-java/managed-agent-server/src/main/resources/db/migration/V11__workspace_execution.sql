CREATE TABLE managed_workspace_execution_lease (
    storage_key CHAR(64) PRIMARY KEY,
    holder_key CHAR(64),
    binding_id VARCHAR(512),
    runtime_generation BIGINT,
    runtime_session_id VARCHAR(512)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

ALTER TABLE qwen_runtime_binding_slot MODIFY COLUMN placement_domain VARCHAR(512) NULL;
ALTER TABLE qwen_runtime_binding_slot MODIFY COLUMN runtime_template_digest VARCHAR(512) NULL;
ALTER TABLE qwen_runtime_binding MODIFY COLUMN placement_domain VARCHAR(512) NULL;
ALTER TABLE qwen_runtime_binding MODIFY COLUMN runtime_template_digest VARCHAR(512) NULL;
