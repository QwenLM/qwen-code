ALTER TABLE managed_agent_command
    ADD COLUMN command_status VARCHAR(32) NOT NULL DEFAULT 'COMPLETED';

ALTER TABLE managed_agent_command
    ADD COLUMN updated_at BIGINT NOT NULL DEFAULT 0;

ALTER TABLE managed_agent_command
    ADD COLUMN session_status_before VARCHAR(32);

ALTER TABLE managed_agent_session
    ADD COLUMN deleted_at BIGINT;

CREATE INDEX managed_agent_command_pending_idx
    ON managed_agent_command (
        tenant_id, session_id, command_status
    );

CREATE INDEX managed_agent_session_status_idx
    ON managed_agent_session (tenant_id, status, updated_at, session_id);
