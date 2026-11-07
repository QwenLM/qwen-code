CREATE TABLE managed_agent_item (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    item_id VARCHAR(128) NOT NULL,
    turn_id VARCHAR(64) NOT NULL,
    item_type VARCHAR(32) NOT NULL,
    item_role VARCHAR(32),
    item_status VARCHAR(32) NOT NULL,
    attributes_json LONGTEXT NOT NULL,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, session_id, item_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX managed_agent_item_history_idx
    ON managed_agent_item (tenant_id, session_id, first_sequence);

CREATE TABLE managed_agent_item_part (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    item_id VARCHAR(128) NOT NULL,
    part_id VARCHAR(128) NOT NULL,
    part_type VARCHAR(32) NOT NULL,
    part_text LONGTEXT NOT NULL,
    first_sequence BIGINT NOT NULL,
    last_sequence BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    PRIMARY KEY (tenant_id, session_id, item_id, part_id),
    FOREIGN KEY (tenant_id, session_id, item_id)
        REFERENCES managed_agent_item (tenant_id, session_id, item_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_agent_snapshot (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    snapshot_version BIGINT NOT NULL,
    covered_sequence BIGINT NOT NULL,
    items_json LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_agent_consumer_progress (
    tenant_id VARCHAR(128) NOT NULL,
    session_id VARCHAR(64) NOT NULL,
    consumer_name VARCHAR(64) NOT NULL,
    covered_sequence BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, session_id, consumer_name),
    FOREIGN KEY (tenant_id, session_id)
        REFERENCES managed_agent_session (tenant_id, session_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

INSERT INTO managed_agent_consumer_progress (
    tenant_id, session_id, consumer_name, covered_sequence, updated_at
)
SELECT tenant_id, session_id, 'message_projection', 0, updated_at
FROM managed_agent_session;
