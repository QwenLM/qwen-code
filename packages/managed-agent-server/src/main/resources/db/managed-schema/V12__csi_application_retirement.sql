ALTER TABLE ma_operation ADD COLUMN progress_format VARCHAR(64);
ALTER TABLE ma_operation ADD COLUMN progress_version BIGINT;
ALTER TABLE ma_operation ADD COLUMN progress_stage VARCHAR(16);
ALTER TABLE ma_operation ADD COLUMN settlement_deadline_ms BIGINT;
ALTER TABLE ma_operation ADD COLUMN frozen_request_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN frozen_request_sha256 CHAR(64);
ALTER TABLE ma_operation ADD COLUMN cut_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN cut_sha256 CHAR(64);
ALTER TABLE ma_operation ADD COLUMN finalize_receipt_bytes LONGBLOB;
ALTER TABLE ma_operation ADD COLUMN finalize_receipt_sha256 CHAR(64);
-- MariaDB refuses an indexed generated column whose expression carries the CHAR source's
-- PAD_CHAR_TO_FULL_LENGTH dependency, so trim the hash before the CASE narrows it to
-- CSI_RETIREMENT rows (MariaDB mysql-test/suite/vcol/t/vcol_sql_mode.test: RTRIM resolves it).
ALTER TABLE ma_operation ADD COLUMN csi_retirement_target_key CHAR(64) GENERATED ALWAYS AS (CASE WHEN operation_kind = 'CSI_RETIREMENT' THEN RTRIM(target_key) ELSE NULL END);
ALTER TABLE ma_operation ADD CONSTRAINT uq_ma_csi_retirement_target UNIQUE (csi_retirement_target_key, target_revision);
