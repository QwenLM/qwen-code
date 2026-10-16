ALTER TABLE ma_session ADD COLUMN selected_approval_mode VARCHAR(32);
ALTER TABLE ma_session ADD COLUMN approval_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ma_session ADD CONSTRAINT ck_ma_session_approval_selection CHECK ((selected_approval_mode IS NULL AND approval_revision = 0) OR (selected_approval_mode IS NOT NULL AND approval_revision >= 1 AND approval_revision <= 9007199254740991 AND (CASE selected_approval_mode WHEN 'default' THEN 7 WHEN 'auto-edit' THEN 9 WHEN 'yolo' THEN 4 ELSE -1 END = CHAR_LENGTH(selected_approval_mode))));
ALTER TABLE ma_turn ADD COLUMN approval_mode VARCHAR(32);
ALTER TABLE ma_turn ADD COLUMN approval_revision BIGINT;
ALTER TABLE ma_turn ADD CONSTRAINT ck_ma_turn_approval_selection CHECK ((approval_mode IS NULL AND approval_revision IS NULL) OR (approval_mode IS NOT NULL AND approval_revision IS NOT NULL AND approval_revision >= 0 AND approval_revision <= 9007199254740991 AND (CASE approval_mode WHEN 'default' THEN 7 WHEN 'auto-edit' THEN 9 WHEN 'yolo' THEN 4 ELSE -1 END = CHAR_LENGTH(approval_mode))));
