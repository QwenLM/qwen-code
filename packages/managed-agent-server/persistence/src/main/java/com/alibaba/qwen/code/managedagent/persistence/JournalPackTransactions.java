package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Transactional SQL boundary for journal pack publication and reclamation (S1b).
 *
 * <p>These operations live in their own bean so the commit boundary is never lost to Spring
 * self-invocation: {@link JdbcJournalPacks#sweep()} calls its own methods through {@code this},
 * which bypasses the proxy, so a {@code @Transactional} annotation on those methods would not be
 * applied and each statement would autocommit. Here the boundary is enforced programmatically with
 * {@link TransactionTemplate}, which commits (or rolls back) as a unit regardless of how the bean
 * was constructed or invoked. The OSS object build and PUT stay in {@link JdbcJournalPacks}
 * <em>outside</em> any SQL transaction; only the catalog/watermark writes are transactional.
 *
 * <p>The BUILDING catalog row is committed in a {@code REQUIRES_NEW} transaction before the object
 * PUT, so a build that crashes after the PUT but before publication still leaves a row that
 * {@link #collectOrphans(long)} can reclaim. Publication then advances the head watermark and marks
 * the pack PUBLISHED in one atomic transaction, so a covered range is never left unreadable.
 */
@Service
public class JournalPackTransactions {
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore objects;
    private final TransactionTemplate buildingTx;
    private final TransactionTemplate requiredTx;

    public JournalPackTransactions(JdbcTemplate jdbc, ToolPublicationObjectStore objects) {
        this.jdbc = jdbc;
        this.objects = objects;
        DataSourceTransactionManager manager =
                new DataSourceTransactionManager(jdbc.getDataSource());
        this.buildingTx = new TransactionTemplate(manager);
        this.buildingTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.requiredTx = new TransactionTemplate(manager);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public JournalPackTransactions(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            org.springframework.beans.factory.ObjectProvider<ToolPublicationObjectStore> objects) {
        this(jdbc, objects.getIfAvailable());
    }

    /** Commits the BUILDING catalog row on its own, before the object PUT. */
    public void insertBuilding(String packId, String scope, String tenant, String workspace,
            String session, long from, long through, String objectKey, long byteLength,
            String objectSha, long now) {
        buildingTx.executeWithoutResult(status -> {
            // A crashed or rolled-back build leaves a BUILDING row at this (scope, from_revision).
            // Reclaim it and its orphaned object before re-inserting, so a retry of the same range
            // does not violate uk_ma_journal_pack_scope_from. Only BUILDING rows are reclaimed; a
            // published pack at this range would already have advanced the watermark past it.
            List<Map<String, Object>> stale = jdbc.queryForList(
                    "SELECT pack_id, object_key FROM ma_journal_pack WHERE session_scope_key = ?"
                            + " AND from_revision = ? AND state = 'BUILDING'",
                    scope, from);
            for (Map<String, Object> row : stale) {
                store().deleteIfPresent(text(row.get("object_key")));
                jdbc.update("DELETE FROM ma_journal_pack WHERE pack_id = ?", row.get("pack_id"));
            }
            jdbc.update("INSERT INTO ma_journal_pack"
                            + " (pack_id, session_scope_key, tenant_id, workspace_id, session_id,"
                            + " from_revision, through_revision, manifest_resource_key, object_key,"
                            + " state, byte_length, sha256, gmt_create, gmt_modified) VALUES (?, ?, ?,"
                            + " ?, ?, ?, ?, ?, ?, 'BUILDING', ?, ?, ?, ?)",
                    packId, scope, tenant, workspace, session, from, through, "", objectKey,
                    byteLength, objectSha, now, now);
        });
    }

    /** Atomically verifies, advances the head watermark and publishes the pack + manifest. */
    public void publish(String packId, String scope, String tenant, String workspace,
            String session, long from, long through, byte[] manifest) {
        String manifestId = "manifest-" + packId;
        requiredTx.executeWithoutResult(status -> {
            jdbc.update("UPDATE ma_journal_pack SET state = 'VERIFIED', gmt_modified = ?"
                    + " WHERE pack_id = ?", System.currentTimeMillis(), packId);
            int published = jdbc.update("UPDATE ma_session_head SET packed_through_revision = ?,"
                            + " gmt_modified = " + ManagedSchemaTime.SQL_NOW
                            + " WHERE tenant_id = ? AND session_id = ? AND head_kind ="
                            + " 'MANAGED_SESSION' AND state = 'ACTIVE' AND"
                            + " COALESCE(compacted_through_revision, 0) = 0 AND"
                            + " packed_through_revision = ? AND journal_revision >= ?",
                    through, tenant, session, from - 1, through);
            if (published != 1) {
                throw JournalStoreRows.conflict("managed_journal_pack_conflict",
                        "The head watermark moved while the pack was being built.");
            }
            jdbc.update("UPDATE ma_journal_pack SET state = 'PUBLISHED', manifest_resource_key = ?,"
                            + " gmt_modified = ? WHERE pack_id = ?",
                    ManagedSessionStore.resourceKey(scope, manifestId),
                    System.currentTimeMillis(), packId);
            jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                            + " workspace_id, session_id, resource_id, kind, schema_version,"
                            + " byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                            + " VALUES (?, ?, ?, ?, ?, ?, 'managed-journal-pack-manifest', 1, ?, ?,"
                            + " 'MYSQL_INLINE', ?, 'REFERENCED', ?)",
                    ManagedSessionStore.resourceKey(scope, manifestId), scope, tenant, workspace,
                    session, manifestId, manifest.length, JournalStoreRows.sha256(manifest),
                    manifest, System.currentTimeMillis());
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                            + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                            + " resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, ?, ?, ?, ?, ?)",
                    scope, packId, ManagedSessionStore.resourceKey(scope, manifestId), tenant,
                    workspace, session, manifestId, System.currentTimeMillis());
        });
    }

    /** Nulls covered SQL blobs for packs past the grace window, in one transaction. */
    public int deleteCoveredBlobs(long cutoff) {
        Integer deleted = requiredTx.execute(status -> {
            // Deterministic oldest-first order plus an EVICTED terminal marker: without both, the
            // same 32 oldest PUBLISHED packs would be re-selected on every pass and the sweep would
            // never reach newer packs. EVICTED packs stay resolvable (see resolveBytes) but are not
            // re-selected here, so each pass makes progress and terminates.
            List<Map<String, Object>> packs = jdbc.queryForList(
                    "SELECT pack_id, session_scope_key, tenant_id, session_id, from_revision,"
                            + " through_revision FROM ma_journal_pack WHERE state = 'PUBLISHED' AND"
                            + " gmt_modified <= ? ORDER BY gmt_modified, pack_id LIMIT 32",
                    cutoff);
            int count = 0;
            for (Map<String, Object> pack : packs) {
                count += jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE"
                                + " tenant_id = ? AND session_id = ? AND journal_revision BETWEEN ? AND ?"
                                + " AND record_bytes IS NOT NULL",
                        pack.get("tenant_id"), pack.get("session_id"), pack.get("from_revision"),
                        pack.get("through_revision"));
                jdbc.update("UPDATE ma_journal_pack SET state = 'EVICTED', gmt_modified = ?"
                                + " WHERE pack_id = ?",
                        System.currentTimeMillis(), pack.get("pack_id"));
            }
            return count;
        });
        return deleted == null ? 0 : deleted;
    }

    /** Collects retired and orphaned pack objects and their SQL rows in one transaction. */
    public int collectOrphans(long cutoff) {
        ToolPublicationObjectStore store = store();
        Integer collected = requiredTx.execute(status -> {
            List<Map<String, Object>> packs = jdbc.queryForList(
                    "SELECT pack_id, session_scope_key, object_key, manifest_resource_key FROM"
                            + " ma_journal_pack WHERE state = 'RETIRED' OR (state = 'BUILDING' AND"
                            + " gmt_modified <= ?) LIMIT 32",
                    cutoff);
            for (Map<String, Object> pack : packs) {
                store.deleteIfPresent(text(pack.get("object_key")));
                String scope = text(pack.get("session_scope_key"));
                String manifestKey = text(pack.get("manifest_resource_key"));
                if (manifestKey != null && !manifestKey.isEmpty()) {
                    jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND"
                            + " resource_id = (SELECT resource_id FROM ma_resource WHERE"
                            + " resource_key = ?)", scope, manifestKey);
                    jdbc.update("DELETE FROM ma_resource WHERE resource_key = ?", manifestKey);
                }
                jdbc.update("DELETE FROM ma_journal_pack WHERE pack_id = ?", pack.get("pack_id"));
            }
            return packs.size();
        });
        return collected == null ? 0 : collected;
    }

    private ToolPublicationObjectStore store() {
        if (objects == null) {
            throw new ManagedAgentException(501, "managed_session_oss_disabled",
                    "Journal compaction requires a configured object store.");
        }
        return objects;
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8)
                : (String) value;
    }
}
