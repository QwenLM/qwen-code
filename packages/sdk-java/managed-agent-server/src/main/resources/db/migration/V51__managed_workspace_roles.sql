/* No default on role: an INSERT omitting it must fail loudly, matching the
   booleans it replaces (an omission used to violate NOT NULL). The column
   therefore arrives NULL, the backfill below supplies every existing row's
   value explicitly, and only then is NOT NULL set. */
ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NULL;
-- A row without can_read grants nothing today; keeping it would gain
-- READER (or OPERATOR, for a can_create row) through the backfill.
DELETE FROM managed_workspace_access WHERE can_read = FALSE;
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access
    MODIFY COLUMN role VARCHAR(16) NOT NULL;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK (role IN ('READER', 'OPERATOR', 'OWNER'));
ALTER TABLE managed_agent_session
    ADD COLUMN owner_actor_key VARBINARY(2048) NULL;
UPDATE managed_agent_session SET owner_actor_key = creator_actor_key;
