CREATE TABLE managed_agent_definition (
    tenant_id VARCHAR(128) NOT NULL,
    agent_id VARCHAR(128) NOT NULL,
    revision BIGINT NOT NULL,
    digest VARCHAR(64) NOT NULL,
    definition_json LONGTEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, agent_id, revision)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE TABLE managed_agent_definition_command (
    tenant_id VARCHAR(128) NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_digest VARCHAR(80) NOT NULL,
    agent_id VARCHAR(128) NOT NULL,
    revision BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, idempotency_key)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
