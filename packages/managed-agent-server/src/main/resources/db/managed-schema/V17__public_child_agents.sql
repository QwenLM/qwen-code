ALTER TABLE ma_session ADD COLUMN public_child_agents_version INT NOT NULL DEFAULT 0;
ALTER TABLE ma_session ADD CONSTRAINT ck_ma_public_child_agents CHECK (public_child_agents_version >= 0 AND public_child_agents_version <= 1);
