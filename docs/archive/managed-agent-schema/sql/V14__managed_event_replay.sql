-- Events keep the versions and the Item and Part identity they were accepted
-- with. V15 fills the identity of rows written before this migration.
ALTER TABLE managed_agent_event
    ADD COLUMN schema_version INT NOT NULL DEFAULT 1;
ALTER TABLE managed_agent_event
    ADD COLUMN projection_version INT NOT NULL DEFAULT 1;
ALTER TABLE managed_agent_event
    ADD COLUMN item_id VARCHAR(128);
ALTER TABLE managed_agent_event
    ADD COLUMN content_part_id VARCHAR(128);

-- Events at or below the floor may be pruned; a replay cursor below it has
-- expired. Nothing prunes events yet, so every Session starts at 0.
ALTER TABLE managed_agent_session
    ADD COLUMN replay_floor_sequence BIGINT NOT NULL DEFAULT 0;
