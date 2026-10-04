-- The per-domain revision total the commit-time chain counter reads for
-- every Stage H domain.committed (ManagedExtensionRecordStore.apply): an
-- index-only range scan over this Session's own rows of the domain,
-- instead of reading every record of the Session.
CREATE INDEX idx_managed_session_extension_domain
    ON qwen_managed_session_extension_record (
        session_scope_key, domain, revision
    );
