CREATE TABLE managed_workspace_csi_retirement (
    retirement_id CHAR(36) PRIMARY KEY,
    binding_id VARCHAR(512) NOT NULL,
    runtime_generation BIGINT NOT NULL,
    physical_key CHAR(64) NOT NULL,
    phase VARCHAR(16) NOT NULL,
    identity_json LONGTEXT NOT NULL,
    UNIQUE (binding_id, runtime_generation)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
