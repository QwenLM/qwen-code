-- Hook admission checks the once key, the occurrence ordinal and the catalog
-- pin of a new record through these projections, instead of reading every
-- earlier Hook record of its Session. They never change across a record's
-- revisions. V29 backfills the rows written before them.
ALTER TABLE qwen_managed_session_extension_record
    ADD COLUMN hook_once_key_hash CHAR(64) NULL;
ALTER TABLE qwen_managed_session_extension_record
    ADD COLUMN hook_occurrence_hash CHAR(64) NULL;
ALTER TABLE qwen_managed_session_extension_record
    ADD COLUMN hook_ordinal BIGINT NULL;
ALTER TABLE qwen_managed_session_extension_record
    ADD COLUMN hook_definition_hash CHAR(64) NULL;

-- A once key is consumed once per Session, and an occurrence numbers its
-- executions once each. Other domains leave the columns null.
CREATE UNIQUE INDEX uq_managed_session_hook_once
    ON qwen_managed_session_extension_record (
        session_scope_key, hook_once_key_hash
    );
CREATE UNIQUE INDEX uq_managed_session_hook_ordinal
    ON qwen_managed_session_extension_record (
        session_scope_key, hook_occurrence_hash, hook_ordinal
    );
CREATE INDEX idx_managed_session_hook_definition
    ON qwen_managed_session_extension_record (
        session_scope_key, hook_definition_hash
    );
