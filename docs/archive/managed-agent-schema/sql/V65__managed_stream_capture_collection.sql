CREATE TABLE qwen_managed_session_resource_collection (
    session_scope_key CHAR(64) NOT NULL,
    tenant_key CHAR(64) NOT NULL,
    session_key CHAR(64) NOT NULL,
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(512) NOT NULL,
    gc_generation BIGINT NOT NULL DEFAULT 0,
    gc_owner VARCHAR(36),
    gc_claim_until BIGINT NOT NULL DEFAULT 0,
    gc_next_at BIGINT NOT NULL DEFAULT 0,
    gc_cursor VARCHAR(512) NOT NULL DEFAULT '',
    gc_blocker VARCHAR(64),
    collected_at BIGINT,
    collected_bytes BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME(6) NOT NULL,
    PRIMARY KEY (session_scope_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE UNIQUE INDEX uq_session_resource_collection_root
    ON qwen_managed_session_resource_collection (tenant_key, session_key);
CREATE INDEX idx_session_resource_collection_due
    ON qwen_managed_session_resource_collection (gc_next_at);
CREATE INDEX idx_output_session_retirement_due ON qwen_output_session_retirement (retired_at);

-- The collector's page-time recovery re-check probes WHERE session_id = ? with a
-- locking read; the table's only key is (operation_id, session_id), so without
-- this index that probe next-key locks the whole table behind every 1 Hz page.
CREATE INDEX idx_workspace_recovery_session_session
    ON managed_workspace_recovery_session (session_id, operation_id);
