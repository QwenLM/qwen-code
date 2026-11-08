CREATE TABLE managed_session_rename_delivery (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    title VARCHAR(256) NOT NULL,
    delivery_state VARCHAR(16) NOT NULL,
    available_at BIGINT NOT NULL,
    lease_owner VARCHAR(128),
    lease_until BIGINT,
    attempt_count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX managed_session_rename_pending_idx
    ON managed_session_rename_delivery (delivery_state, available_at);
