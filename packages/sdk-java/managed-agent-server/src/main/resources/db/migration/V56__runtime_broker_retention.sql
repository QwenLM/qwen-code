CREATE INDEX idx_runtime_binding_retention
    ON qwen_runtime_binding (binding_state, last_active_at, binding_id);
CREATE INDEX idx_runtime_binding_tenant_state
    ON qwen_runtime_binding (tenant_id, binding_state);
CREATE INDEX idx_workspace_execution_binding
    ON managed_workspace_execution_lease (binding_id, runtime_generation);
CREATE INDEX idx_tool_publication_execution_key
    ON qwen_tool_publication (execution_key);
CREATE INDEX idx_csi_worker_ack_execution
    ON managed_workspace_csi_worker_ack (execution_call_id_hash);
