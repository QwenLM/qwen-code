ALTER TABLE managed_agent_session ADD COLUMN workspace_id VARCHAR(128);
ALTER TABLE managed_agent_session ADD COLUMN workspace_generation BIGINT;
ALTER TABLE managed_agent_session ADD COLUMN workspace_storage_id VARCHAR(256);
ALTER TABLE managed_agent_session ADD COLUMN cwd_relative VARCHAR(2048);
ALTER TABLE managed_agent_session ADD COLUMN context_config_ref VARCHAR(512);
ALTER TABLE managed_agent_session ADD COLUMN context_revision BIGINT;
ALTER TABLE managed_agent_session ADD COLUMN workspace_config_ref VARCHAR(512);
ALTER TABLE managed_agent_session ADD COLUMN workspace_policy_ref VARCHAR(512);

ALTER TABLE managed_agent_session ADD CONSTRAINT managed_workspace_binding_complete
    CHECK ((workspace_id IS NULL
                AND workspace_generation IS NULL
                AND workspace_storage_id IS NULL
                AND cwd_relative IS NULL
                AND context_config_ref IS NULL
                AND context_revision IS NULL
                AND workspace_config_ref IS NULL
                AND workspace_policy_ref IS NULL)
            OR (workspace_id IS NOT NULL
                AND workspace_generation > 0
                AND workspace_storage_id IS NOT NULL
                AND cwd_relative IS NOT NULL
                AND context_config_ref IS NOT NULL
                AND context_revision > 0
                AND workspace_config_ref IS NOT NULL
                AND workspace_policy_ref IS NOT NULL));
