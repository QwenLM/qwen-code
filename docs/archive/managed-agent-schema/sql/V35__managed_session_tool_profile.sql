ALTER TABLE managed_agent_session
    ADD COLUMN tool_profile VARCHAR(64) DEFAULT 'hosted-workspace-files/1';

UPDATE managed_agent_session SET tool_profile = NULL WHERE workspace_id IS NULL;
