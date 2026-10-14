CREATE TABLE managed_workspace_csi_physical (
    retirement_id CHAR(36) PRIMARY KEY,
    binding_id VARCHAR(512) NOT NULL,
    physical_key CHAR(64) NOT NULL,
    record_version BIGINT NOT NULL,
    record_bytes LONGBLOB NOT NULL,
    record_sha256 CHAR(64) NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE UNIQUE INDEX idx_workspace_csi_physical_binding ON managed_workspace_csi_physical (binding_id);
CREATE INDEX idx_workspace_csi_physical_key ON managed_workspace_csi_physical (physical_key);
