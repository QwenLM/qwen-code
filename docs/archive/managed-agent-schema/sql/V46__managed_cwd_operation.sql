-- Controlled same-Workspace cwd changes (W2): a durable operation carries
-- the normalized target directory and the context-revision CAS it was
-- admitted with, and records the revision it committed. error_code from V24
-- already stores the public failure code of a terminal refusal.
ALTER TABLE managed_agent_operation ADD COLUMN target_cwd_relative VARCHAR(2048);
ALTER TABLE managed_agent_operation ADD COLUMN expected_context_revision BIGINT;
ALTER TABLE managed_agent_operation ADD COLUMN result_context_revision BIGINT;
