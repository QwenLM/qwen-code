-- The recording actor of a command row, so an idempotent replay answers
-- the caller who recorded the command and not only the Session's creator:
-- an OPERATOR's own retry of his own key is the retry the idempotency key
-- exists for. NULL on pre-V66 rows; those keep answering to the creator
-- alone.
ALTER TABLE managed_agent_command
    ADD COLUMN actor_key VARBINARY(2048) NULL;
