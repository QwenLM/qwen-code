/* No default on role: an INSERT omitting it must fail loudly, matching the
   booleans it replaces (an omission used to violate NOT NULL). The column
   therefore arrives NULL, the backfill below supplies every existing row's
   value explicitly, and only then is NOT NULL set. */
ALTER TABLE managed_workspace_access
    ADD COLUMN role VARCHAR(16) NULL;
-- A row without can_read grants nothing today; keeping it would gain
-- READER (or OPERATOR, for a can_create row) through the backfill.
DELETE FROM managed_workspace_access WHERE can_read = FALSE;
UPDATE managed_workspace_access
    SET role = CASE WHEN can_create THEN 'OPERATOR' ELSE 'READER' END;
ALTER TABLE managed_workspace_access
    MODIFY COLUMN role VARCHAR(16) NOT NULL;
ALTER TABLE managed_workspace_access DROP COLUMN can_read;
ALTER TABLE managed_workspace_access DROP COLUMN can_create;
/* utf8mb4 comparisons ignore trailing spaces (PAD SPACE), so a plain IN
   list would store 'READER ' — which the enum parser then rejects at
   read time. Equality plus a length per name pins the stored values
   byte-exact ('READER ' matches 'READER' under PAD SPACE but is 7
   chars, not 6). The predicate carries no backslash, so neither H2 nor
   MySQL's string-literal escaping can rewrite it on the way in. */
ALTER TABLE managed_workspace_access
    ADD CONSTRAINT managed_workspace_access_role
    CHECK ((role = 'READER' AND CHAR_LENGTH(role) = 6)
        OR (role = 'OPERATOR' AND CHAR_LENGTH(role) = 8)
        OR (role = 'OWNER' AND CHAR_LENGTH(role) = 5));
ALTER TABLE managed_agent_session
    ADD COLUMN owner_actor_key VARBINARY(2048) NULL;
UPDATE managed_agent_session SET owner_actor_key = creator_actor_key;
