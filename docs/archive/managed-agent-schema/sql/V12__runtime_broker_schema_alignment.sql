-- Align the Runtime Broker tables with runtime-broker's schema.sql, which its
-- JDBC repositories are written against. RuntimeBrokerFlywaySchemaTest keeps
-- the two definitions equal.

-- H2 cannot drop and add a primary key in one statement, so each swap takes
-- two. A unique key covers the gap. MySQL rejects the first DROP PRIMARY KEY
-- when sql_require_primary_key is set; it runs first so that nothing else has
-- changed by then.

-- Executions are keyed by the hash of their call ID.
ALTER TABLE qwen_tool_execution DROP PRIMARY KEY;
ALTER TABLE qwen_tool_execution ADD PRIMARY KEY (execution_call_id_hash);
ALTER TABLE qwen_tool_execution DROP INDEX uq_tool_execution_call_hash;

-- A Runtime Session ID is unique within its scope.
ALTER TABLE qwen_runtime_session
    ADD CONSTRAINT uq_runtime_session_scope
        UNIQUE (scope_key, runtime_session_id);
ALTER TABLE qwen_runtime_session DROP PRIMARY KEY;
ALTER TABLE qwen_runtime_session
    ADD PRIMARY KEY (scope_key, runtime_session_id);
ALTER TABLE qwen_runtime_session DROP INDEX uq_runtime_session_scope;
ALTER TABLE qwen_runtime_session DROP INDEX idx_runtime_session_scope;

-- A slot is keyed by its request key. One isolation key can own several
-- slots, for example in another scope or Workspace generation.
ALTER TABLE qwen_runtime_binding_slot DROP INDEX uq_runtime_binding_isolation;

ALTER TABLE qwen_runtime_binding_slot
    MODIFY COLUMN provisioner_kind VARCHAR(512) NOT NULL;
ALTER TABLE qwen_runtime_binding
    MODIFY COLUMN provisioner_kind VARCHAR(512) NOT NULL;

-- The repositories never write these columns.
ALTER TABLE qwen_runtime_binding_slot DROP COLUMN placement_domain;
ALTER TABLE qwen_runtime_binding_slot DROP COLUMN runtime_template_digest;
ALTER TABLE qwen_runtime_binding DROP COLUMN placement_domain;
ALTER TABLE qwen_runtime_binding DROP COLUMN runtime_template_digest;
