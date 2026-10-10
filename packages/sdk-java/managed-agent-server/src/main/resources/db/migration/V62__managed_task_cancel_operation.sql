-- Public task cancel (Stage H4f of #12827): a task_cancel operation shares
-- the durable operation table with the lifecycle and cwd commands and names
-- the task it targets. NULL on every other kind. error_code from V24 already
-- stores the failure code a definitively refused cancellation reports.
ALTER TABLE managed_agent_operation ADD COLUMN task_id VARCHAR(128) NULL;
