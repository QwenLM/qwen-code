CREATE TABLE managed_workspace_csi_worker_ack (
    retirement_id CHAR(36) NOT NULL,
    execution_call_id_hash CHAR(64) NOT NULL,
    execution_call_id VARCHAR(512) NOT NULL,
    evidence_json LONGTEXT NOT NULL,
    evidence_digest CHAR(64) NOT NULL,
    recorded_at_epoch_micros BIGINT NOT NULL,
    PRIMARY KEY (retirement_id, execution_call_id_hash)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
