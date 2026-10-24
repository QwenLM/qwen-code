CREATE TABLE managed_workspace_registry (
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(128) NOT NULL,
    workspace_generation BIGINT NOT NULL,
    storage_id VARCHAR(256) NOT NULL,
    display_name VARCHAR(512) NOT NULL,
    config_ref VARCHAR(512) NOT NULL,
    policy_ref VARCHAR(512) NOT NULL,
    state VARCHAR(16) NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id),
    CHECK (workspace_generation > 0),
    CHECK (state IN ('ACTIVE', 'DRAINING', 'REMOVED'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_workspace_access (
    tenant_id VARCHAR(128) NOT NULL,
    workspace_id VARCHAR(128) NOT NULL,
    actor_id VARBINARY(2048) NOT NULL,
    can_read BOOLEAN NOT NULL,
    can_create BOOLEAN NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES managed_workspace_registry (tenant_id, workspace_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE managed_workspace_default (
    tenant_id VARCHAR(128) NOT NULL PRIMARY KEY,
    workspace_id VARCHAR(128) NOT NULL,
    FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES managed_workspace_registry (tenant_id, workspace_id)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
