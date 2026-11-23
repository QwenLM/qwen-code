package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRef;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.apache.commons.codec.digest.DigestUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Service;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
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
    private static final Logger LOG = LoggerFactory.getLogger(JournalPackTransactions.class);
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore objects;
    private final TransactionTemplate transactions;
    private long orphanCursor;
    private long orphanRoundEnd;

    public JournalPackTransactions(JdbcTemplate jdbc, ToolPublicationObjectStore objects) {
        this.jdbc = jdbc;
        this.objects = objects;
        DataSourceTransactionManager manager =
                new DataSourceTransactionManager(jdbc.getDataSource());
        this.transactions = new TransactionTemplate(manager);
        this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public JournalPackTransactions(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            org.springframework.beans.factory.ObjectProvider<ToolPublicationObjectStore> objects) {
        this(jdbc, objects.getIfAvailable());
    }

    /** Commits the BUILDING catalog row on its own, before the object PUT. */
    public void insertBuilding(String packId, String tenant, String workspace,
            String session, long from, long through, String objectKey, long byteLength,
            String objectSha, long now, String builderId, long reclaimCutoff) {
        transactions.executeWithoutResult(status -> {
            requireActiveSession(tenant, session);
            // Expiry releases the range, not the old key: its single PUT may still land later.
            jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED', gmt_modified = ?"
                            + " WHERE tenant_id = ? AND session_id = ? AND active_from_revision = ?"
                            + " AND state = 'BUILDING' AND gmt_modified <= ?",
                    now, tenant, session, from, reclaimCutoff);
            jdbc.update("INSERT INTO ma_journal_pack"
                            + " (pack_id, tenant_id, workspace_id, session_id,"
                            + " from_revision, through_revision, manifest_resource_ref, object_key,"
                            + " state, byte_length, sha256, builder_id, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'BUILDING', ?, ?, ?, ?, ?)",
                    packId, tenant, workspace, session, from, through, "", objectKey,
                    byteLength, objectSha, builderId, now, now);
        });
    }

    /** Records closure independently, including for an already retired attempt. */
    public void markPutClosed(String packId, String tenant, String session,
            String objectKey) {
        transactions.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
            jdbc.update("UPDATE ma_journal_pack SET is_put_closed = 1 WHERE pack_id = ?"
                            + " AND tenant_id = ? AND session_id = ?"
                            + " AND object_key = ? AND is_put_closed = 0",
                    packId, tenant, session, objectKey);
        });
    }

    /** A failed attempt never retires a different builder or a published pack. */
    public void retireBuilding(String packId, String tenant, String session) {
        transactions.executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
            jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED', gmt_modified = ?"
                            + " WHERE pack_id = ? AND tenant_id = ?"
                            + " AND session_id = ? AND state = 'BUILDING'",
                    System.currentTimeMillis(), packId, tenant, session);
        });
    }

    /** Atomically verifies, advances the head watermark and publishes the pack + manifest. */
    public void publish(String packId, String tenant, String workspace,
            String session, long from, long through, byte[] manifest) {
        String manifestId = "manifest-" + packId;
        String manifestRef = ManagedIdentityRefs.resourceRef(tenant, session, manifestId);
        transactions.executeWithoutResult(status -> {
            requireActiveSession(tenant, session);
            // Root -> head -> pack -> resource, matching retirement and eviction.
            int verified = jdbc.update("UPDATE ma_journal_pack SET state = 'VERIFIED',"
                            + " gmt_modified = ? WHERE pack_id = ?"
                            + " AND tenant_id = ? AND workspace_id = ? AND session_id = ?"
                            + " AND from_revision = ? AND through_revision = ?"
                            + " AND state = 'BUILDING' AND is_put_closed = 1",
                    System.currentTimeMillis(), packId, tenant, workspace, session,
                    from, through);
            if (verified != 1) {
                throw JournalStoreRows.conflict("managed_journal_pack_conflict",
                        "The pack row was reclaimed by a concurrent compaction before verification.");
            }
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
            int publishedRow = jdbc.update("UPDATE ma_journal_pack SET state = 'PUBLISHED',"
                            + " manifest_resource_ref = ?, gmt_modified = ? WHERE pack_id = ?"
                            + " AND state = 'VERIFIED'",
                    ManagedSchemaKeys.identity(manifestRef),
                    System.currentTimeMillis(), packId);
            if (publishedRow != 1) {
                throw JournalStoreRows.conflict("managed_journal_pack_conflict",
                        "The pack row was reclaimed by a concurrent compaction before publication.");
            }
            jdbc.update("INSERT INTO ma_resource (tenant_id,"
                            + " workspace_id, session_id, resource_id, kind, schema_version,"
                            + " byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                            + " VALUES (?, ?, ?, ?, 'managed-journal-pack-manifest', 1, ?, ?,"
                            + " 'MYSQL_INLINE', ?, 'REFERENCED', ?)",
                    tenant, workspace,
                    session, manifestId, manifest.length, JournalStoreRows.sha256(manifest),
                    manifest, System.currentTimeMillis());
            jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_ref,"
                            + " owner_revision, tenant_id, workspace_id, session_id,"
                            + " resource_id, gmt_create) VALUES ('JOURNAL', ?, 1, ?, ?, ?, ?, ?)",
                    ManagedSchemaKeys.identity(ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES, packId)),
                    tenant, workspace, session, manifestId, System.currentTimeMillis());
        });
    }

    /** Marks a covered pack EVICTED and nulls its SQL blobs in the same short transaction. */
    public int deleteCoveredBlobs(long cutoff) {
        List<Map<String, Object>> packs = jdbc.queryForList(
                "SELECT pack_id, tenant_id, session_id FROM ma_journal_pack WHERE"
                        + " state = 'PUBLISHED' AND gmt_modified <= ?"
                        + " ORDER BY gmt_modified, pack_id LIMIT 32", cutoff);
        int count = 0;
        for (Map<String, Object> candidate : packs) {
            Integer deleted = transactions.execute(status -> {
                String tenant = text(candidate.get("tenant_id"));
                String session = text(candidate.get("session_id"));
                ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
                // SEALED is the normal resting state between writer leases; an ACTIVE-only
                // recheck leaves aged sealed-head packs PUBLISHED forever, and 32 of them
                // stall the global LIMIT 32 window fleet-wide. Coverage is proven by the
                // packed-through-revision comparison below, for any head state.
                List<Map<String, Object>> heads = jdbc.queryForList(
                        "SELECT packed_through_revision FROM ma_session_head WHERE tenant_id = ?"
                                + " AND session_id = ? AND head_kind = 'MANAGED_SESSION'"
                                + " AND COALESCE(compacted_through_revision, 0) = 0 FOR UPDATE",
                        tenant, session);
                Map<String, Object> pack = lockPack(candidate);
                if (heads.isEmpty() || pack == null || !"PUBLISHED".equals(pack.get("state"))
                        || ((Number) pack.get("gmt_modified")).longValue() > cutoff
                        || ((Number) heads.getFirst().get("packed_through_revision")).longValue()
                                < ((Number) pack.get("through_revision")).longValue()) {
                    return 0;
                }
                int evicted = jdbc.update("UPDATE ma_journal_pack SET state = 'EVICTED',"
                                + " gmt_modified = ? WHERE pack_id = ? AND state = 'PUBLISHED'"
                                + " AND is_put_closed = 1",
                        System.currentTimeMillis(), pack.get("pack_id"));
                if (evicted != 1) {
                    return 0;
                }
                return jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE"
                                + " tenant_id = ? AND session_id = ? AND journal_revision BETWEEN ? AND ?"
                                + " AND record_bytes IS NOT NULL",
                        tenant, session, pack.get("from_revision"), pack.get("through_revision"));
            });
            count += deleted == null ? 0 : deleted;
        }
        return count;
    }

    /** Commits retirement before object IO; uncertain PUTs remain durable deletion debt. */
    public int collectOrphans(long cutoff) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Pack collection requires no ambient transaction");
        }
        ToolPublicationObjectStore store = store();
        List<Map<String, Object>> candidates;
        synchronized (this) {
            if (orphanCursor == 0) {
                orphanRoundEnd = jdbc.queryForObject("SELECT COALESCE(MAX(id), 0) FROM ma_journal_pack", Long.class);
            }
            candidates = jdbc.queryForList("SELECT p.*, CASE WHEN state = 'RETIRED'"
                    + " OR (state = 'BUILDING' AND gmt_modified <= ?) THEN 1 ELSE 0 END AS eligible"
                    + " FROM (SELECT id, pack_id, tenant_id, session_id, state, gmt_modified FROM ma_journal_pack"
                    + " WHERE id > ? AND id <= ? ORDER BY id LIMIT 32) p ORDER BY id", cutoff, orphanCursor, orphanRoundEnd);
            // A fixed round end revisits unknown PUTs even while new packs keep arriving.
            long last = candidates.isEmpty() ? 0 : ((Number) candidates.getLast().get("id")).longValue();
            orphanCursor = candidates.size() < 32 || last >= orphanRoundEnd ? 0 : last;
        }
        int collected = 0;
        for (Map<String, Object> candidate : candidates) {
            if (((Number) candidate.get("eligible")).intValue() == 0) {
                continue;
            }
            try {
                Map<String, Object> pack = transactions.execute(status -> {
                    ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc,
                            text(candidate.get("tenant_id")), text(candidate.get("session_id")));
                    Map<String, Object> locked = lockPack(candidate);
                    if (locked == null) {
                        return null;
                    }
                    if ("BUILDING".equals(locked.get("state"))
                            && ((Number) locked.get("gmt_modified")).longValue() <= cutoff) {
                        jdbc.update("UPDATE ma_journal_pack SET state = 'RETIRED', gmt_modified = ?"
                                        + " WHERE pack_id = ? AND state = 'BUILDING'",
                                System.currentTimeMillis(), locked.get("pack_id"));
                    } else if (!"RETIRED".equals(locked.get("state"))) {
                        return null;
                    }
                    return locked;
                });
                if (pack == null) {
                    continue;
                }
                String key = text(pack.get("object_key"));
                if (((Number) pack.get("is_put_closed")).intValue() == 0) {
                    if (!matchesObject(pack)) {
                        continue;
                    }
                    markPutClosed(text(pack.get("pack_id")),
                            text(pack.get("tenant_id")), text(pack.get("session_id")), key);
                }
                store.deleteIfPresent(key);
                Integer deleted = transactions.execute(status -> {
                    ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc,
                            text(pack.get("tenant_id")), text(pack.get("session_id")));
                    Map<String, Object> locked = lockPack(pack);
                    if (locked == null || !"RETIRED".equals(locked.get("state"))
                            || ((Number) locked.get("is_put_closed")).intValue() != 1
                            || !key.equals(text(locked.get("object_key")))
                            || !pack.get("id").equals(locked.get("id"))) {
                        return 0;
                    }
                    String manifestRef = text(locked.get("manifest_resource_ref"));
                    if (!manifestRef.isEmpty()) {
                        String manifestId = ManagedIdentityRef.decode(
                                manifestRef.getBytes(StandardCharsets.US_ASCII)).get(2);
                        jdbc.update("DELETE FROM ma_resource_ref WHERE tenant_id = ? AND session_id = ?"
                                        + " AND owner_kind = 'JOURNAL' AND owner_ref = ?"
                                        + " AND resource_id = ?",
                                locked.get("tenant_id"), locked.get("session_id"),
                                ManagedSchemaKeys.identity(ManagedIdentityRefs.ref(
                                        ManagedIdentityRefs.OWNER_REF_BYTES, text(locked.get("pack_id")))),
                                manifestId);
                        jdbc.update("DELETE FROM ma_resource WHERE tenant_id = ? AND session_id = ?"
                                + " AND resource_id = ?", locked.get("tenant_id"),
                                locked.get("session_id"), manifestId);
                    }
                    return jdbc.update("DELETE FROM ma_journal_pack WHERE id = ? AND pack_id = ?"
                                    + " AND state = 'RETIRED' AND is_put_closed = 1 AND object_key = ?",
                            locked.get("id"), locked.get("pack_id"), key);
                });
                collected += deleted == null ? 0 : deleted;
            } catch (RuntimeException error) {
                LOG.warn("Journal pack collection failed for {}; retaining deletion debt",
                        text(candidate.get("pack_id")), error);
            }
        }
        return collected;
    }

    private Map<String, Object> lockPack(Map<String, Object> identity) {
        List<Map<String, Object>> packs = jdbc.queryForList(
                "SELECT * FROM ma_journal_pack WHERE pack_id = ? AND tenant_id = ?"
                        + " AND session_id = ? FOR UPDATE",
                identity.get("pack_id"), identity.get("tenant_id"), identity.get("session_id"));
        return packs.isEmpty() ? null : packs.getFirst();
    }

    private void requireActiveSession(String tenant, String session) {
        Map<String, Object> head =
                ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
        ToolPublicationRetentionStore.requireLive(jdbc, tenant, session);
        if (head == null || !"ACTIVE".equals(head.get("state"))) {
            throw JournalStoreRows.conflict("managed_journal_pack_conflict",
                    "Journal pack publication requires an active Session.");
        }
    }

    private boolean matchesObject(Map<String, Object> pack) {
        long expectedLength = ((Number) pack.get("byte_length")).longValue();
        MessageDigest digest = DigestUtils.getSha256Digest();
        long length = 0;
        try (InputStream stream = store().open(text(pack.get("object_key")), () -> {})) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) != -1) {
                length += read;
                if (length > expectedLength) {
                    return false;
                }
                digest.update(buffer, 0, read);
            }
        } catch (IOException error) {
            throw new IllegalStateException("Pack reconciliation read failed", error);
        }
        return length == expectedLength
                && java.util.HexFormat.of().formatHex(digest.digest()).equals(pack.get("sha256"));
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
