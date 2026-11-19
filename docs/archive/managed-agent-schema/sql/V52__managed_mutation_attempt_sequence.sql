-- Existing receipts retain their original requested-event boundary until retried.
ALTER TABLE managed_agent_command ADD COLUMN mutation_attempt_sequence BIGINT;
