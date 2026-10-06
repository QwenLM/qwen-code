-- H4b of #12827: child Session lineage, the relay's discovery index, and
-- the relay ledger. The ledger name is deliberately its own: V45 reserves
-- qwen_managed_session_task_event for the later task-view outbox.

ALTER TABLE managed_agent_session
    ADD COLUMN parent_session_id VARCHAR(64) NULL;
ALTER TABLE managed_agent_session
    ADD COLUMN root_session_id VARCHAR(64) NULL;
ALTER TABLE managed_agent_session
    ADD COLUMN parent_child_run_id VARCHAR(512) NULL;
ALTER TABLE managed_agent_session
    ADD COLUMN child_depth INT NULL;

CREATE INDEX idx_managed_agent_session_parent
    ON managed_agent_session (parent_session_id, status);

-- The child result relay's discovery scan: child_agent runs are the only
-- child_run rows whose delivery line is materialized (shell rows carry
-- none), so (domain, delivery_state) selects exactly what needs creation
-- or delivery reconciliation.
CREATE INDEX idx_managed_session_extension_delivery
    ON qwen_managed_session_extension_record (domain, delivery_state);

-- The relay's own ledger, one row per claimed child run. Classifications
-- (orphaned, unknown) outlive the worker and must never re-present as
-- consumable or trigger re-execution; claims expire so a stalled worker
-- yields its rows to another.
CREATE TABLE qwen_managed_child_result_relay (
    tenant_id VARCHAR(128) NOT NULL,
    parent_session_id VARCHAR(64) NOT NULL,
    child_run_id VARCHAR(512) NOT NULL,
    creation_key VARCHAR(128) NOT NULL,
    child_session_id VARCHAR(64),
    state VARCHAR(24) NOT NULL,
    claimed_by VARCHAR(128),
    claimed_until BIGINT,
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at BIGINT NOT NULL DEFAULT 0,
    last_error VARCHAR(1024),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (parent_session_id, child_run_id),
    UNIQUE KEY uq_child_result_relay_creation (tenant_id, creation_key),
    INDEX idx_child_result_relay_poll (state, next_retry_at)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
