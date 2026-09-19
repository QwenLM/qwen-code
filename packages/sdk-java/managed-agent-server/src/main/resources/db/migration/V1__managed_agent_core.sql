CREATE TABLE managed_agent_session (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    harness_session_id VARCHAR(36) NOT NULL,
    agent_id VARCHAR(128) NOT NULL,
    title VARCHAR(512),
    status VARCHAR(32) NOT NULL,
    harness_boot_id VARCHAR(36),
    harness_event_epoch VARCHAR(64),
    harness_last_event_id BIGINT NOT NULL DEFAULT 0,
    last_sequence BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id),
    UNIQUE (harness_session_id)
);

CREATE INDEX managed_agent_session_list_idx
    ON managed_agent_session (tenant_id, updated_at, session_id);

CREATE TABLE managed_agent_turn (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    turn_id VARCHAR(64) NOT NULL,
    prompt_id VARCHAR(36) NOT NULL,
    input_json LONGTEXT NOT NULL,
    payload_digest VARCHAR(71) NOT NULL,
    status VARCHAR(32) NOT NULL,
    submission_attempted BOOLEAN NOT NULL DEFAULT FALSE,
    harness_event_epoch VARCHAR(64),
    harness_last_event_id BIGINT,
    dispatch_owner VARCHAR(128),
    dispatch_lease_until BIGINT,
    error_code VARCHAR(128),
    error_message VARCHAR(2048),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    completed_at BIGINT,
    version BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, session_id, turn_id),
    UNIQUE (prompt_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
);

CREATE INDEX managed_agent_turn_dispatch_idx
    ON managed_agent_turn (status, dispatch_lease_until, updated_at);

CREATE TABLE managed_agent_command (
    tenant_id VARCHAR(128) NOT NULL,
    operation VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_digest VARCHAR(71) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    turn_id VARCHAR(64),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE TABLE managed_agent_event (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    sequence_id BIGINT NOT NULL,
    event_id VARCHAR(64) NOT NULL,
    turn_id VARCHAR(64),
    event_type VARCHAR(128) NOT NULL,
    data_json LONGTEXT NOT NULL,
    terminal BOOLEAN NOT NULL,
    source_key VARCHAR(256),
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, sequence_id),
    UNIQUE (event_id),
    UNIQUE (tenant_id, session_id, source_key),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
);

CREATE INDEX managed_agent_event_turn_idx
    ON managed_agent_event (tenant_id, session_id, turn_id, sequence_id);
