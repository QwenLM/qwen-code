CREATE INDEX idx_runtime_session_id ON qwen_runtime_session (runtime_session_id);
CREATE INDEX managed_workspace_migration_completed_idx
    ON managed_workspace_migration (tenant_id, storage_id, state, updated_at);
