-- The cwd-change initiator, so settlement can re-check the operating
-- actor, not only the recorded create-command actor. NULL on pre-V54
-- operations; those settle on the creator-keyed facts alone.
ALTER TABLE managed_agent_operation
    ADD COLUMN actor_key VARBINARY(2048) NULL;
