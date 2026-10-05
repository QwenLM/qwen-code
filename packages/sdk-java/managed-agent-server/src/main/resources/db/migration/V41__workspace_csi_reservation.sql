CREATE TABLE managed_workspace_csi_registration (
    alias_key CHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(256) NOT NULL,
    storage_id VARCHAR(256) NOT NULL,
    physical_key CHAR(64) NOT NULL,
    registration_revision BIGINT NOT NULL,
    registration_json LONGTEXT NOT NULL
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE INDEX idx_workspace_csi_physical
    ON managed_workspace_csi_registration (physical_key);

ALTER TABLE managed_workspace_execution_lease ADD COLUMN storage_kind VARCHAR(16) NOT NULL DEFAULT 'LOCAL';
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_phase VARCHAR(16) NOT NULL DEFAULT 'RELEASED';
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_reservation_id CHAR(36);
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_registration_key CHAR(64);
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_registration_revision BIGINT;
ALTER TABLE managed_workspace_execution_lease ADD COLUMN csi_provision_request_id VARCHAR(512);
