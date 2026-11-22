CREATE TABLE managed_agent_action (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    action_id VARCHAR(128) NOT NULL,
    state VARCHAR(32) NOT NULL,
    options_json LONGTEXT NOT NULL,
    decision_receipt_id VARCHAR(128),
    decision_digest VARCHAR(64),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, action_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE INDEX managed_agent_action_pending_idx
    ON managed_agent_action (tenant_id, session_id, state, created_at, action_id);
ALTER TABLE managed_agent_operation ADD COLUMN action_id VARCHAR(128);
ALTER TABLE managed_agent_operation ADD COLUMN response_json LONGTEXT;
ALTER TABLE managed_agent_operation ADD COLUMN error_code VARCHAR(128);
ALTER TABLE managed_agent_operation ADD COLUMN decision_receipt_id VARCHAR(128);
ALTER TABLE managed_agent_session ADD COLUMN approval_mode VARCHAR(32) NOT NULL DEFAULT 'yolo';
