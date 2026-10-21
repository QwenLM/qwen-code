ALTER TABLE ma_schedule ADD gate VARCHAR(2048) NULL;
ALTER TABLE ma_schedule ADD gate_last_outcome VARCHAR(16) NULL;
ALTER TABLE ma_schedule ADD gate_last_at BIGINT UNSIGNED NULL;
ALTER TABLE ma_schedule ADD gate_quiet_since_delivery INT NOT NULL DEFAULT 0;
ALTER TABLE ma_schedule ADD gate_failures INT NOT NULL DEFAULT 0;
ALTER TABLE ma_schedule ADD gate_last_error VARCHAR(1024) NULL;
