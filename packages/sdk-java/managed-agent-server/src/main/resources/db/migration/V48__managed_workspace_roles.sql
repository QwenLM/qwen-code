ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'READER';
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK (role IN ('READER', 'OPERATOR', 'OWNER'));
ALTER TABLE managed_agent_session
    ADD COLUMN owner_actor_key VARBINARY(2048) NULL;
UPDATE managed_agent_session SET owner_actor_key = creator_actor_key;
