CREATE TABLE managed_workspace_create_command (
    tenant_id VARCHAR(128) NOT NULL,
    actor_id VARBINARY(2048) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_digest VARCHAR(71) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    turn_id VARCHAR(64),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, actor_id, idempotency_key),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
