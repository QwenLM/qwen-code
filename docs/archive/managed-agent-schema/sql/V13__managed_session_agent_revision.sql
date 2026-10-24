ALTER TABLE managed_agent_session
    ADD COLUMN agent_revision VARCHAR(128) NOT NULL DEFAULT '1';
