package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * Immutable journal packs (S1b): a contiguous committed prefix of {@code record_bytes} is
 * compressed per transaction into one never-overwritten object, verified, then published
 * atomically with the head watermark. Per-transaction compression keeps range reads possible:
 * the pack index addresses compressed chunks. Covered SQL blobs are deleted only after a grace
 * window; retirement retires packs and the sweeper collects their objects. SQL metadata
 * (digests, sequences) is never deleted, so the digest chain stays verifiable from SQL plus
 * pack bytes.
 */
@Service
public class JdbcJournalPacks {
    private static final byte[] MAGIC = {'Q', 'J', 'P', 'K'};
    private final JdbcTemplate jdbc;
    private final ToolPublicationObjectStore objects;
    private final ManagedAgentSettings settings;

    public JdbcJournalPacks(JdbcTemplate jdbc, ToolPublicationObjectStore objects,
            ManagedAgentSettings settings) {
        this.jdbc = jdbc;
        this.objects = objects;
        this.settings = settings;
    }

    @org.springframework.beans.factory.annotation.Autowired
    public JdbcJournalPacks(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            org.springframework.beans.factory.ObjectProvider<ToolPublicationObjectStore> objects,
            ManagedAgentSettings settings) {
        this(jdbc, objects.getIfAvailable(), settings);
    }

    private ManagedAgentSettings.SessionResources config() {
        ManagedAgentSettings.SessionResources config = settings.getSessionResources();
        if (config == null || !config.isEnabled()) {
            throw new ManagedAgentException(501, "managed_session_oss_disabled",
                    "Journal compaction is disabled.");
        }
        return config;
    }

    private ToolPublicationObjectStore store() {
        if (objects == null) {
            throw new ManagedAgentException(501, "managed_session_oss_disabled",
                    "Journal compaction requires a configured object store.");
        }
        return objects;
    }

    /** Builds, verifies and atomically publishes one pack; returns false when nothing to do. */
    @Transactional
    public boolean compactOnce(String tenant, String workspace, String session) {
        ManagedAgentSettings.SessionResources config = config();
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        Map<String, Object> head = headSnapshot(tenant, session);
        if (head == null || !"ACTIVE".equals(head.get("state"))
                || ((Number) head.get("compacted_through_revision")).longValue() != 0) {
            return false;
        }
        long journalRevision = ((Number) head.get("journal_revision")).longValue();
        long from = ((Number) head.get("packed_through_revision")).longValue() + 1;
        long through = Math.min(journalRevision, from + config.getPackMaxTransactions() - 1);
        if (through < from) {
            return false;
        }
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT journal_revision, record_bytes, record_digest FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND journal_revision BETWEEN ?"
                        + " AND ? ORDER BY journal_revision",
                tenant, session, from, through);
        if (rows.size() != through - from + 1) {
            return false;
        }
        ByteArrayOutputStream payload = new ByteArrayOutputStream();
        StringBuilder index = new StringBuilder("{\"entries\":[");
        long uncompressedBytes = 0;
        for (Map<String, Object> row : rows) {
            byte[] bytes = (byte[]) row.get("record_bytes");
            if (bytes == null) {
                return false;
            }
            byte[] chunk = gzip(bytes);
            long revision = ((Number) row.get("journal_revision")).longValue();
            if (index.length() > "{\"entries\":[".length()) {
                index.append(',');
            }
            index.append("{\"r\":").append(revision).append(",\"o\":").append(payload.size())
                    .append(",\"l\":").append(chunk.length).append('}');
            payload.writeBytes(chunk);
            uncompressedBytes += bytes.length;
        }
        index.append("]}");
        byte[] compressed = payload.toByteArray();
        if (compressed.length > config.getPackTargetBytes()) {
            return false;
        }
        byte[] indexBytes = index.toString().getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream object = new ByteArrayOutputStream();
        object.writeBytes(compressed);
        object.writeBytes(indexBytes);
        object.writeBytes(ByteBuffer.allocate(8).putLong(indexBytes.length).array());
        object.writeBytes(MAGIC);
        byte[] objectBytes = object.toByteArray();
        String packId = "pack-" + UUID.randomUUID();
        String objectKey = config.getOssKeyPrefix() + "packs/" + scope + "/" + packId;
        long now = System.currentTimeMillis();
        jdbc.update("INSERT INTO ma_journal_pack (pack_id, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, from_revision, through_revision,"
                        + " manifest_resource_key, object_key, state, byte_length, sha256,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?,"
                        + " 'BUILDING', ?, ?, ?, ?)",
                packId, scope, tenant, workspace, session, from, through, "", objectKey,
                objectBytes.length, JournalStoreRows.sha256(objectBytes), now, now);
        store().putIfAbsent(objectKey, objectBytes);
        byte[] readBack = readFully(store().open(objectKey, () -> { }));
        if (!JournalStoreRows.sha256(readBack).equals(JournalStoreRows.sha256(objectBytes))) {
            throw JournalStoreRows.conflict("managed_journal_pack_corrupt",
                    "The published pack object does not match its digest.");
        }
        jdbc.update("UPDATE ma_journal_pack SET state = 'VERIFIED', gmt_modified = ?"
                + " WHERE pack_id = ?", System.currentTimeMillis(), packId);
        String manifestId = "manifest-" + packId;
        byte[] manifest = ("{\"packId\":\"" + packId + "\",\"fromRevision\":" + from
                + ",\"throughRevision\":" + through + ",\"txCount\":" + rows.size()
                + ",\"uncompressedBytes\":" + uncompressedBytes + ",\"compressedBytes\":"
                + compressed.length + ",\"packSha256\":\"" + JournalStoreRows.sha256(objectBytes)
                + "\",\"indexSha256\":\"" + JournalStoreRows.sha256(indexBytes) + "\"}")
                .getBytes(StandardCharsets.UTF_8);
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
                session, manifestId, manifest.length, JournalStoreRows.sha256(manifest), manifest,
                System.currentTimeMillis());
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                        + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                        + " resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, ?, ?, ?, ?, ?)",
                scope, packId, ManagedSessionStore.resourceKey(scope, manifestId), tenant,
                workspace, session, manifestId, System.currentTimeMillis());
        return true;
    }

    /** Returns pack bytes for a covered revision, or null when the revision is SQL-hot. */
    public byte[] resolveBytes(String tenant, String session, long revision, String digest,
            long byteLength) {
        Map<String, Object> head = headSnapshot(tenant, session);
        if (head == null || revision > ((Number) head.get("packed_through_revision")).longValue()) {
            return null;
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        List<Map<String, Object>> packs = jdbc.queryForList(
                "SELECT pack_id, object_key, byte_length FROM ma_journal_pack WHERE"
                        + " session_scope_key = ? AND state = 'PUBLISHED' AND from_revision <= ?"
                        + " AND through_revision >= ? ORDER BY from_revision",
                scope, revision, revision);
        if (packs.isEmpty()) {
            throw JournalStoreRows.conflict("managed_journal_pack_corrupt",
                    "A covered journal revision has no published pack.");
        }
        Map<String, Object> pack = packs.getFirst();
        ToolPublicationObjectStore store = store();
        long size = ((Number) pack.get("byte_length")).longValue();
        byte[] trailer = readFully(store.openRange(text(pack.get("object_key")), size - 12, 12,
                () -> { }));
        if (trailer[8] != MAGIC[0] || trailer[9] != MAGIC[1] || trailer[10] != MAGIC[2]
                || trailer[11] != MAGIC[3]) {
            throw JournalStoreRows.conflict("managed_journal_pack_corrupt",
                    "The pack object trailer is invalid.");
        }
        long indexLength = ByteBuffer.wrap(trailer, 0, 8).getLong();
        byte[] indexBytes = readFully(store.openRange(text(pack.get("object_key")),
                size - 12 - indexLength, indexLength, () -> { }));
        long[] entry = findEntry(new String(indexBytes, StandardCharsets.UTF_8), revision);
        byte[] chunk = readFully(store.openRange(text(pack.get("object_key")), entry[0],
                entry[1], () -> { }));
        byte[] bytes = gunzip(chunk);
        if (bytes.length != byteLength || !JournalStoreRows.sha256(bytes).equals(digest)) {
            throw JournalStoreRows.conflict("managed_journal_pack_corrupt",
                    "The packed journal record does not match its SQL digest.");
        }
        return bytes;
    }

    /** Deletes covered SQL blobs for packs past the grace window; idempotent and batched. */
    @Transactional
    public int deleteCoveredBlobs() {
        ManagedAgentSettings.SessionResources config = config();
        if (!config.isDeletionEnabled()) {
            return 0;
        }
        long cutoff = System.currentTimeMillis() - config.getDeletionGrace().toMillis();
        List<Map<String, Object>> packs = jdbc.queryForList(
                "SELECT pack_id, session_scope_key, tenant_id, session_id, from_revision,"
                        + " through_revision FROM ma_journal_pack WHERE state = 'PUBLISHED' AND"
                        + " gmt_modified <= ? LIMIT 32",
                cutoff);
        int deleted = 0;
        for (Map<String, Object> pack : packs) {
            deleted += jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = NULL WHERE"
                            + " tenant_id = ? AND session_id = ? AND journal_revision BETWEEN ? AND ?"
                            + " AND record_bytes IS NOT NULL",
                    pack.get("tenant_id"), pack.get("session_id"), pack.get("from_revision"),
                    pack.get("through_revision"));
        }
        return deleted;
    }

    /** Collects retired and orphaned pack objects; never touches published live packs. */
    @Transactional
    public int collectOrphans() {
        ManagedAgentSettings.SessionResources config = config();
        long cutoff = System.currentTimeMillis() - config.getDeletionGrace().toMillis();
        List<Map<String, Object>> packs = jdbc.queryForList(
                "SELECT pack_id, session_scope_key, object_key, manifest_resource_key FROM"
                        + " ma_journal_pack WHERE state = 'RETIRED' OR (state = 'BUILDING' AND"
                        + " gmt_modified <= ?) LIMIT 32",
                cutoff);
        ToolPublicationObjectStore store = store();
        for (Map<String, Object> pack : packs) {
            store.deleteIfPresent(text(pack.get("object_key")));
            String scope = (String) pack.get("session_scope_key");
            String manifestKey = (String) pack.get("manifest_resource_key");
            if (manifestKey != null && !manifestKey.isEmpty()) {
                jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND"
                        + " resource_id = (SELECT resource_id FROM ma_resource WHERE"
                        + " resource_key = ?)", scope, manifestKey);
                jdbc.update("DELETE FROM ma_resource WHERE resource_key = ?", manifestKey);
            }
            jdbc.update("DELETE FROM ma_journal_pack WHERE pack_id = ?", pack.get("pack_id"));
        }
        return packs.size();
    }

    /** One sweeper pass: compact candidates, then grace deletion, then orphan collection. */
    public void sweep() {
        ManagedAgentSettings.SessionResources config = settings.getSessionResources();
        if (config == null || !config.isEnabled()) {
            return;
        }
        if (config.isPackJobEnabled()) {
            List<Map<String, Object>> candidates = jdbc.queryForList(
                    "SELECT tenant_id, workspace_id, session_id FROM ma_session_head WHERE"
                            + " head_kind = 'MANAGED_SESSION' AND state = 'ACTIVE' AND"
                            + " packed_through_revision < journal_revision LIMIT 16");
            for (Map<String, Object> candidate : candidates) {
                try {
                    compactOnce((String) candidate.get("tenant_id"),
                            (String) candidate.get("workspace_id"),
                            (String) candidate.get("session_id"));
                } catch (RuntimeException error) {
                    // A failed pack must never block other sessions; the next sweep retries.
                }
            }
            deleteCoveredBlobs();
        }
        collectOrphans();
    }

    private static String text(Object value) {
        return value instanceof byte[] bytes ? new String(bytes, StandardCharsets.UTF_8)
                : (String) value;
    }

    private Map<String, Object> headSnapshot(String tenant, String session) {
        List<Map<String, Object>> heads = jdbc.queryForList(
                "SELECT state, COALESCE(journal_revision, 0) AS journal_revision,"
                        + " COALESCE(packed_through_revision, 0) AS packed_through_revision,"
                        + " COALESCE(compacted_through_revision, 0) AS compacted_through_revision"
                        + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND"
                        + " head_kind = 'MANAGED_SESSION'",
                tenant, session);
        return heads.isEmpty() ? null : heads.getFirst();
    }

    private static long[] findEntry(String indexJson, long revision) {
        int cursor = indexJson.indexOf("{\"r\":" + revision + ",");
        if (cursor < 0) {
            throw JournalStoreRows.conflict("managed_journal_pack_corrupt",
                    "The pack index does not cover the requested revision.");
        }
        int offsetStart = indexJson.indexOf("\"o\":", cursor) + 4;
        int offsetEnd = indexJson.indexOf(',', offsetStart);
        int lengthStart = indexJson.indexOf("\"l\":", offsetEnd) + 4;
        int lengthEnd = indexJson.indexOf('}', lengthStart);
        return new long[] {Long.parseLong(indexJson.substring(offsetStart, offsetEnd)),
                Long.parseLong(indexJson.substring(lengthStart, lengthEnd))};
    }

    private static byte[] gzip(byte[] bytes) {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
                gzip.write(bytes);
            }
            return out.toByteArray();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Pack compression failed", error);
        }
    }

    private static byte[] gunzip(byte[] compressed) {
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            return gzip.readAllBytes();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Pack decompression failed", error);
        }
    }

    private static byte[] readFully(InputStream stream) {
        try (stream) {
            return stream.readAllBytes();
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Pack read failed", error);
        }
    }
}
