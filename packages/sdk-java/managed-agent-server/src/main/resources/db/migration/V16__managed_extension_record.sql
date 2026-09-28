-- The latest revision of each Stage H record a Managed Session committed
-- (managed-extension-record/1), with its SessionTaskView projection and its
-- delivery line. The Session store writes a row in the transaction that
-- commits the revision, so the task list and the outbox commit with it.
CREATE TABLE qwen_managed_session_extension_record (
    session_scope_key CHAR(64) NOT NULL,
    record_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(512) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    domain VARCHAR(64) NOT NULL,
    record_id VARCHAR(512) NOT NULL,
    operation_hash CHAR(64) NOT NULL,
    revision BIGINT NOT NULL,
    record_resource_id VARCHAR(512) NOT NULL,
    task_kind VARCHAR(32) NOT NULL,
    task_state VARCHAR(32) NOT NULL,
    runtime_state VARCHAR(32),
    definition_revision BIGINT,
    delivery_target VARCHAR(16),
    delivery_state VARCHAR(16),
    created_at BIGINT NOT NULL,
    started_at BIGINT,
    settled_at BIGINT,
    PRIMARY KEY (session_scope_key, record_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_managed_session_extension_task
    ON qwen_managed_session_extension_record (
        session_scope_key, created_at, record_key
    );

-- A first revision checks that its command opened no other record.
CREATE INDEX idx_managed_session_extension_operation
    ON qwen_managed_session_extension_record (
        session_scope_key, operation_hash
    );
