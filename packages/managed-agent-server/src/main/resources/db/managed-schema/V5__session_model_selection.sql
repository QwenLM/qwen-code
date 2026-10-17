ALTER TABLE ma_session ADD COLUMN model_id VARBINARY(512);
ALTER TABLE ma_session ADD COLUMN model_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ma_session ADD CONSTRAINT ck_ma_session_model_selection CHECK ((model_id IS NULL AND model_revision = 0) OR (model_id IS NOT NULL AND model_revision >= 1 AND model_revision <= 9007199254740991));
ALTER TABLE ma_turn ADD COLUMN model_id VARBINARY(512);
ALTER TABLE ma_turn ADD COLUMN model_revision BIGINT;
ALTER TABLE ma_turn ADD CONSTRAINT ck_ma_turn_model_selection CHECK ((model_id IS NULL AND model_revision IS NULL) OR (model_id IS NOT NULL AND model_revision IS NOT NULL AND model_revision >= 1 AND model_revision <= 9007199254740991));
