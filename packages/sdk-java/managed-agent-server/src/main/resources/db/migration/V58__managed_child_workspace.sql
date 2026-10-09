-- The isolation slice of #12827 (#13753, I1): the child Workspace, a Git
-- linked worktree inside the parent's storage, and its durable command.
-- One row per child run holds the recorded base, the merge evidence and the
-- outcome; claims fence the writers and the scan resumes the work. See
-- docs/design/2026-10-09-managed-child-workspace.md.
CREATE TABLE qwen_managed_child_workspace (
    tenant_id VARCHAR(128) NOT NULL,
    parent_session_id VARCHAR(64) NOT NULL,
    child_run_id VARCHAR(512) NOT NULL,
    child_workspace_id CHAR(32) NOT NULL,
    workspace_id VARCHAR(128) NOT NULL,
    workspace_generation BIGINT NOT NULL,
    storage_id VARCHAR(256) NOT NULL,
    parent_cwd_relative VARCHAR(2048) NOT NULL,
    repository_relative VARCHAR(2048),
    child_cwd_relative VARCHAR(2048),
    base_commit VARCHAR(64),
    result_commit VARCHAR(64),
    parent_tree VARCHAR(64),
    merged_tree VARCHAR(64),
    state VARCHAR(16) NOT NULL,
    finish_request VARCHAR(16),
    outcome_code VARCHAR(64),
    conflict_paths LONGTEXT,
    last_error VARCHAR(1024),
    claimed_by VARCHAR(128),
    claimed_until BIGINT,
    claim_generation BIGINT NOT NULL DEFAULT 0,
    attempts INT NOT NULL DEFAULT 0,
    next_retry_at BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (parent_session_id, child_run_id),
    UNIQUE KEY uq_child_workspace_id (child_workspace_id),
    INDEX idx_child_workspace_poll (state, next_retry_at)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- The maintenance holder of a storage: the child Workspace whose physical
-- step holds the execution lease. Null for every Runtime holder and for an
-- idle lease.
ALTER TABLE managed_workspace_execution_lease
    ADD COLUMN maintenance_id CHAR(32) NULL;
