-- Durable close, archive and delete operations (Stage D4). The idempotency
-- domain is the Session, the kind, the actor and the key; actor_digest is ''
-- for a request without a trusted actor.
CREATE TABLE managed_agent_operation (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    operation_id VARCHAR(64) NOT NULL,
    operation_kind VARCHAR(32) NOT NULL,
    actor_digest VARCHAR(71) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_digest VARCHAR(71) NOT NULL,
    state VARCHAR(32) NOT NULL,
    admission_stage VARCHAR(32) NOT NULL,
    delivery_state VARCHAR(32) NOT NULL,
    session_status_before VARCHAR(32) NOT NULL,
    receipt_id VARCHAR(128),
    lease_owner VARCHAR(128),
    lease_until BIGINT,
    claim_generation BIGINT NOT NULL DEFAULT 0,
    attempt_count INT NOT NULL DEFAULT 0,
    available_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    completed_at BIGINT,
    PRIMARY KEY (tenant_id, session_id, operation_id),
    UNIQUE (operation_id),
    UNIQUE (tenant_id, session_id, operation_kind, actor_digest,
        idempotency_key),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX managed_agent_operation_pending_idx
    ON managed_agent_operation (delivery_state, available_at);

CREATE INDEX managed_agent_operation_lease_idx
    ON managed_agent_operation (delivery_state, lease_until);

-- An archive or delete that waited for a retry before this migration becomes
-- a pending operation under its original key and digest, which the worker
-- finishes. It has no actor, so only a retry without a trusted actor replays
-- it.
INSERT INTO managed_agent_operation (tenant_id, session_id, operation_id,
    operation_kind, actor_digest, idempotency_key, request_digest, state,
    admission_stage, delivery_state, session_status_before, available_at,
    created_at, updated_at)
SELECT tenant_id, session_id, CONCAT('op_', REPLACE(UUID(), '-', '')),
    CASE operation WHEN 'ARCHIVE_SESSION' THEN 'ARCHIVE' ELSE 'DELETE' END,
    '', idempotency_key, request_digest, 'PENDING', 'JAVA_DURABLE',
    'PENDING', COALESCE(session_status_before, 'ACTIVE'), updated_at,
    created_at, updated_at
FROM managed_agent_command
WHERE operation IN ('ARCHIVE_SESSION', 'DELETE_SESSION')
    AND command_status = 'PENDING';

UPDATE managed_agent_command SET command_status = 'MIGRATED'
WHERE operation IN ('ARCHIVE_SESSION', 'DELETE_SESSION')
    AND command_status = 'PENDING';
