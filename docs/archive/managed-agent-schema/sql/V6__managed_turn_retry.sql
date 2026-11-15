ALTER TABLE managed_agent_turn
    ADD COLUMN retry_count INT NOT NULL DEFAULT 0;

ALTER TABLE managed_agent_turn
    ADD COLUMN retry_after BIGINT;
