ALTER TABLE ma_session ADD COLUMN plan_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ma_session ADD CONSTRAINT ck_ma_session_plan CHECK (plan_enabled = FALSE OR (selected_approval_mode IS NOT NULL AND approval_revision >= 1));
ALTER TABLE ma_turn ADD COLUMN plan_enabled BOOLEAN;
ALTER TABLE ma_turn ADD CONSTRAINT ck_ma_turn_plan CHECK (plan_enabled IS NULL OR (approval_mode IS NOT NULL AND approval_revision IS NOT NULL AND (plan_enabled = FALSE OR approval_revision >= 1)));
