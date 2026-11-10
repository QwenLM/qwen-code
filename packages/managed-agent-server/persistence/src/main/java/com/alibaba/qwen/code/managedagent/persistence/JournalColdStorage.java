package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedJournalAccess;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract.OperationKind;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.lang.Nullable;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/** SQL owns the residency and manifest. Every provider call is made without a SQL transaction. */
@Repository
public class JournalColdStorage implements ManagedJournalAccess {
    private static final Logger LOG = LoggerFactory.getLogger(JournalColdStorage.class);
    private static final long COOLING_MILLIS = Duration.ofDays(7).toMillis();
    private static final long RETAIN_MILLIS = Duration.ofHours(24).toMillis();
    private static final long MIN_BYTES = 32L * 1024 * 1024;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transactions;
    private final ImmutableObjectStore objects;
    private final ManagedAgentSettings settings;
    private final ObjectMapper json;
    private final ToolPublicationRetentionStore retention;
    private long archiveCursor;
    private long hydrationCursor;
    private String invalidationCursor = "";

    public JournalColdStorage(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            @Nullable ImmutableObjectStore objects, @Nullable ManagedAgentSettings settings,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.jdbc = jdbc;
        this.transactions = new TransactionTemplate(manager);
        this.objects = objects;
        this.settings = settings;
        this.json = json;
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
    }

    @Override
    public Lease pinHot(String tenant, String session) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        ensureHot(tenant, session);
        if (head(tenant, session) == null) {
            return new Lease() {
                @Override
                public void check() { JournalResidencyGuard.requireHot(jdbc, tenant, session); }
                @Override
                public void close() { }
            };
        }
        return transactions.execute(status -> {
            ToolPublicationRetentionStore.lockSessionHeadWithoutGuard(jdbc, tenant, session);
            JournalResidencyGuard.requireHot(jdbc, tenant, session);
            if (Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_csi_guard FROM ma_session WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session))) {
                return new Lease() {
                    @Override
                    public void check() {
                        JournalResidencyGuard.requireHot(jdbc, tenant, session);
                        if (!Boolean.TRUE.equals(jdbc.queryForObject("SELECT is_csi_guard FROM ma_session WHERE tenant_id = ? AND session_id = ?", Boolean.class, tenant, session))) {
                            throw JournalResidencyGuard.rehydrating();
                        }
                    }

                    @Override
                    public void close() { }
                };
            }
            var lease = retention.read(tenant, session);
            return new Lease() {
                @Override
                public void check() {
                    if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()) {
                        lease.checkReadView();
                    } else {
                        lease.check();
                    }
                    JournalResidencyGuard.requireHot(jdbc, tenant, session);
                }

                @Override
                public void close() {
                    lease.close();
                }
            };
        });
    }

    @Override
    public void ensureHot(String tenant, String session) {
        ensureHot(tenant, session, System.nanoTime() + Duration.ofSeconds(20).toNanos());
    }

    private void ensureHot(String tenant, String session, long deadline) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        var state = head(tenant, session);
        if (state == null || "HOT".equals(state.get("journal_residency"))) {
            return;
        }
        if (objects == null) {
            throw SessionResourceBodies.unavailable();
        }
        Job job = transactions.execute(status -> {
            ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
            var current = head(tenant, session);
            if (current == null || "HOT".equals(current.get("journal_residency"))) {
                return null;
            }
            String archive = (String) current.get("journal_archive_operation_key");
            var operation = operation(archive);
            if (!List.of("PACKED", "EVICTING", "COLD", "HYDRATING").contains(operation.get("phase"))) {
                throw JournalResidencyGuard.rehydrating();
            }
            long epoch = number(current, "journal_archive_epoch");
            if (!"HYDRATING".equals(current.get("journal_residency"))) {
                epoch = Math.addExact(epoch, 1);
                jdbc.update("UPDATE ma_session_head SET journal_residency = 'HYDRATING', journal_archive_epoch = ? WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        epoch, tenant, session);
                jdbc.update("UPDATE ma_operation SET phase = 'HYDRATING', gmt_modified = ? WHERE operation_key = ?", now(), archive);
            }
            String hydration = ManagedSchemaKeys.operationKey(OperationKind.JOURNAL_HYDRATE,
                    ManagedSessionStore.sessionScopeKey(tenant, session), archive, Long.toString(epoch));
            createOperation(hydration, tenant, session, (String) current.get("workspace_id"), "JOURNAL_HYDRATE", number(current, "journal_revision"),
                    json.createObjectNode().put("archive", archive).put("epoch", epoch).toString());
            return job(current, archive, hydration, epoch);
        });
        if (job == null) {
            return;
        }
        hydrate(job, deadline);
    }

    @Scheduled(fixedDelay = 30000)
    public void tick() {
        try {
            runOnce();
        } catch (RuntimeException failure) {
            LOG.warn("Journal cold storage will retry", failure);
        }
    }

    public synchronized boolean runOnce() {
        if (objects == null) {
            return false;
        }
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        releaseRedundantPacks();
        invalidateChangedCuts();
        var hydrating = jdbc.query("SELECT id, tenant_id, session_id FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION' AND journal_residency = 'HYDRATING' AND id > ? ORDER BY id LIMIT 1",
                (row, index) -> ManagedSchemaRows.read(row), hydrationCursor);
        if (!hydrating.isEmpty()) {
            hydrationCursor = number(hydrating.getFirst(), "id");
            ensureHot((String) hydrating.getFirst().get("tenant_id"), (String) hydrating.getFirst().get("session_id"), System.nanoTime() + Duration.ofSeconds(60).toNanos());
            return true;
        }
        hydrationCursor = 0;
        if (settings == null || !settings.getObjectStore().isJournalColdStorageEnabled()) {
            return false;
        }
        var candidates = jdbc.query("SELECT h.tenant_id, h.session_id, s.id FROM ma_session_head h JOIN ma_session s ON s.tenant_id = h.tenant_id AND s.session_id = h.session_id"
                + " WHERE h.head_kind = 'MANAGED_SESSION' AND h.state = 'SEALED' AND h.journal_residency IN ('HOT','EVICTING')"
                + " AND s.status IN ('CLOSED','ARCHIVED') AND s.retired_at IS NULL AND s.is_csi_guard = FALSE"
                + " AND h.gmt_modified <= ? AND s.gmt_modified <= ? AND s.id > ? ORDER BY s.id LIMIT 8",
                (row, index) -> ManagedSchemaRows.read(row), now() - COOLING_MILLIS, now() - COOLING_MILLIS, archiveCursor);
        for (var candidate : candidates) {
            archiveCursor = number(candidate, "id");
            if (archive((String) candidate.get("tenant_id"), (String) candidate.get("session_id"))) {
                return true;
            }
        }
        if (candidates.size() < 8) {
            archiveCursor = 0;
        }
        return false;
    }

    boolean archive(String tenant, String session) {
        SessionResourceBodies.requireOutsideTransaction(jdbc);
        if (settings == null || !settings.getObjectStore().isJournalColdStorageEnabled() || objects == null) {
            return false;
        }
        Job job = transactions.execute(status -> {
            ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
            var head = head(tenant, session);
            if (head == null || !eligible(tenant, session, head)) {
                return null;
            }
            String archive = (String) head.get("journal_archive_operation_key");
            long epoch = number(head, "journal_archive_epoch");
            if (archive == null) {
                epoch = Math.addExact(epoch, 1);
                archive = ManagedSchemaKeys.operationKey(OperationKind.JOURNAL_ARCHIVE, ManagedSessionStore.sessionScopeKey(tenant, session),
                        ManagedSessionStore.sessionScopeKey(tenant, session), UUID.randomUUID().toString());
                String request = json.createObjectNode().put("epoch", epoch).put("revision", number(head, "journal_revision"))
                        .put("sequence", number(head, "committed_sequence")).put("commitDigest", (String) head.get("last_commit_digest"))
                        .put("writerGeneration", number(head, "writer_generation")).toString();
                createOperation(archive, tenant, session, (String) head.get("workspace_id"), "JOURNAL_ARCHIVE", number(head, "journal_revision"), request);
                jdbc.update("UPDATE ma_session_head SET journal_archive_epoch = ?, journal_archive_operation_key = ? WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                        epoch, archive, tenant, session);
            }
            return job(head, archive, archive, epoch);
        });
        if (job == null) {
            return false;
        }
        var operation = operation(job.archive());
        if ("PACKING".equals(operation.get("phase"))) {
            verifyChain(job);
            long after = 0;
            int ordinal = 0;
            String manifestDigest = "";
            while (after < job.revision()) {
                check(job, "HOT");
                var records = page(job, after);
                if (records.isEmpty()) {
                    throw JournalStoreRows.journalCorrupt();
                }
                Pack pack = pack(job, ++ordinal, records);
                verifyPack(job, pack, "HOT", Long.MAX_VALUE);
                manifestDigest = DigestUtils.sha256Hex(manifestDigest + ":" + pack.first() + ":" + pack.last() + ":" + pack.digest());
                after = pack.last();
            }
            int count = ordinal;
            String digest = manifestDigest;
            transactions.executeWithoutResult(status -> {
                lock(job, "HOT");
                if (!eligible(job.tenant(), job.session(), head(job.tenant(), job.session()))) {
                    throw JournalResidencyGuard.rehydrating();
                }
                String result = json.createObjectNode().put("packCount", count).put("manifestDigest", digest).toString();
                jdbc.update("UPDATE ma_operation SET phase = 'PACKED', result_json = ?, gmt_modified = ? WHERE operation_key = ?", result, now(), job.archive());
            });
        }
        if (!settings.getObjectStore().isJournalEvictionEnabled()) {
            return true;
        }
        transactions.executeWithoutResult(status -> {
            lock(job, "HOT", "EVICTING");
            if (!eligible(job.tenant(), job.session(), head(job.tenant(), job.session()))) {
                throw JournalResidencyGuard.rehydrating();
            }
            jdbc.update("UPDATE ma_session_head SET journal_residency = 'EVICTING', storage_version = GREATEST(storage_version, 6) WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                    job.tenant(), job.session());
            jdbc.update("UPDATE ma_operation SET phase = 'EVICTING', gmt_modified = ? WHERE operation_key = ?", now(), job.archive());
        });
        for (Pack pack : manifest(job)) {
            var records = verifyPack(job, pack, "EVICTING", Long.MAX_VALUE);
            writeBodies(job, records, false, Long.MAX_VALUE);
        }
        transactions.executeWithoutResult(status -> {
            lock(job, "EVICTING");
            if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND record_bytes IS NOT NULL", Long.class,
                    job.tenant(), job.session()) != 0) {
                throw JournalStoreRows.journalCorrupt();
            }
            jdbc.update("UPDATE ma_session_head SET journal_residency = 'COLD' WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", job.tenant(), job.session());
            jdbc.update("UPDATE ma_operation SET phase = 'COLD', gmt_modified = ? WHERE operation_key = ?", now(), job.archive());
        });
        return true;
    }

    private void hydrate(Job job, long deadline) {
        var saved = operation(job.operation()).get("result_json");
        long through = saved == null ? 0 : JdbcManagedToolResultStore.parse((String) saved).path("through").asLong(-1);
        if (through < 0 || through > job.revision()) {
            throw JournalStoreRows.journalCorrupt();
        }
        for (Pack pack : manifest(job)) {
            if (pack.last() <= through) {
                continue;
            }
            var records = verifyPack(job, pack, "HYDRATING", deadline);
            long completed = through;
            writeBodies(job, records.stream().filter(record -> record.revision() > completed).toList(), true, deadline);
        }
        verifyHydrated(job, deadline);
        transactions.executeWithoutResult(status -> {
            lock(job, "HYDRATING");
            long present = jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision <= ? AND record_bytes IS NOT NULL",
                    Long.class, job.tenant(), job.session(), job.revision());
            if (present != job.revision()) {
                throw JournalStoreRows.journalCorrupt();
            }
            jdbc.update("UPDATE ma_session_head SET journal_residency = 'HOT', gmt_modified = ? WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                    now(), job.tenant(), job.session());
            jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED', phase = 'HOT', completed_at = ?, gmt_modified = ? WHERE operation_key IN (?, ?)",
                    now(), now(), job.archive(), job.operation());
        });
    }

    private void verifyHydrated(Job job, long deadline) {
        JsonNode progress = JdbcManagedToolResultStore.parse((String) operation(job.operation()).get("result_json"));
        long verified = progress.path("verifiedThrough").asLong(0);
        long sequence = progress.path("sequence").asLong(0);
        String digest = progress.path("digest").isTextual() ? progress.path("digest").textValue() : null;
        if (verified < 0 || verified > job.revision() || sequence < 0) {
            throw JournalStoreRows.journalCorrupt();
        }
        while (verified < job.revision()) {
            if (System.nanoTime() > deadline) {
                throw JournalResidencyGuard.rehydrating();
            }
            check(job, "HYDRATING");
            var records = page(job, verified);
            if (records.isEmpty()) {
                throw JournalStoreRows.journalCorrupt();
            }
            for (var record : records) {
                if (record.bytes() == null || !DigestUtils.sha256Hex(record.bytes()).equals(record.digest())) {
                    throw JournalStoreRows.journalCorrupt();
                }
            }
            long through = records.getLast().revision();
            var metadata = jdbc.query("SELECT journal_revision, first_sequence, last_sequence, event_count, previous_commit_digest, commit_digest, record_encoding FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision",
                    (row, index) -> ManagedSchemaRows.read(row), job.tenant(), job.session(), verified, through);
            for (var row : metadata) {
                long count = number(row, "event_count");
                if (number(row, "journal_revision") != ++verified || !"identity".equals(row.get("record_encoding"))
                        || !Objects.equals(digest, row.get("previous_commit_digest"))
                        || number(row, "first_sequence") != (count == 0 ? sequence : sequence + 1)
                        || number(row, "last_sequence") != sequence + count) {
                    throw JournalStoreRows.journalCorrupt();
                }
                sequence += count;
                digest = (String) row.get("commit_digest");
            }
            if (verified != through) {
                throw JournalStoreRows.journalCorrupt();
            }
            String result = json.createObjectNode().put("through", job.revision()).put("verifiedThrough", verified)
                    .put("sequence", sequence).put("digest", digest).toString();
            transactions.executeWithoutResult(status -> {
                lock(job, "HYDRATING");
                jdbc.update("UPDATE ma_operation SET result_json = ?, gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'JOURNAL_HYDRATE'",
                        result, now(), job.operation());
            });
        }
        if (sequence != job.sequence() || !Objects.equals(digest, job.digest())) {
            throw JournalStoreRows.journalCorrupt();
        }
        if (System.nanoTime() > deadline) {
            throw JournalResidencyGuard.rehydrating();
        }
    }

    private List<JournalPackCodec.Record> page(Job job, long after) {
        var candidates = jdbc.queryForList("SELECT journal_revision, byte_length FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision LIMIT ?",
                job.tenant(), job.session(), after, job.revision(), JournalPackCodec.MAX_RECORDS);
        long total = 0;
        long through = after;
        for (var row : candidates) {
            long length = number(row, "byte_length");
            if (through > after && total + length > JournalPackCodec.TARGET_BYTES) {
                break;
            }
            if (number(row, "journal_revision") != through + 1 || length < 1 || length > 8 * 1024 * 1024) {
                throw JournalStoreRows.journalCorrupt();
            }
            total += length;
            through++;
        }
        return jdbc.query("SELECT journal_revision, record_bytes, record_digest FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision",
                (row, index) -> new JournalPackCodec.Record(row.getLong(1), row.getBytes(2), row.getString(3)), job.tenant(), job.session(), after, through);
    }

    private Pack pack(Job job, int ordinal, List<JournalPackCodec.Record> records) {
        byte[] bytes;
        try {
            bytes = JournalPackCodec.encode(records, () -> check(job, "HOT"));
        } catch (IOException failure) {
            throw JournalStoreRows.journalCorrupt();
        }
        String id = "journal-pack:" + job.archive() + ":" + ordinal;
        String scope = ManagedSessionStore.sessionScopeKey(job.tenant(), job.session());
        String resource = ManagedSessionStore.resourceKey(scope, id);
        Pack pack = new Pack(resource, "journal/" + scope + "/" + job.archive() + "/" + ordinal, objects.identity(), bytes.length,
                DigestUtils.sha256Hex(bytes), records.getFirst().revision(), records.getLast().revision());
        boolean create = Boolean.TRUE.equals(transactions.execute(status -> {
            lock(job, "HOT");
            var work = work(job, resource);
            if (!work.isEmpty()) {
                if (!parsePack((String) work.getFirst().get("payload_json")).equals(pack)) {
                    throw JournalStoreRows.journalCorrupt();
                }
                return false;
            }
            jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, store_id, object_key, publish_command_id, state, gmt_create)"
                    + " VALUES (?, ?, ?, ?, ?, ?, 'managed-journal-pack', 1, ?, ?, 'OBJECT_STORE', ?, ?, ?, 'ALLOCATED', ?)",
                    resource, scope, job.tenant(), job.workspace(), job.session(), id, bytes.length, pack.digest(), pack.store(), pack.key(), job.archive(), now());
            jdbc.update("INSERT INTO ma_operation_work (operation_key, work_kind, target_key, target_id, tenant_id, session_id, state, revision, payload_json, evidence_resource_key, evidence_sha256, gmt_create, gmt_modified)"
                    + " VALUES (?, 'RESOURCE', ?, ?, ?, ?, 'IN_FLIGHT', ?, ?, ?, ?, ?, ?)", job.archive(), resource, id, job.tenant(), job.session(), ordinal,
                    encode(pack), resource, pack.digest(), now(), now());
            String put = ManagedSchemaKeys.operationKey(OperationKind.OBJECT_PUT, scope, resource, job.archive());
            String request = json.createObjectNode().put("archive", job.archive()).put("epoch", job.epoch())
                    .put("writerGeneration", job.generation()).put("resourceKey", resource).toString();
            jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, operation_kind, tenant_id, workspace_id, session_id, target_kind, target_key, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, 'OBJECT_PUT', ?, ?, ?, 'RESOURCE', ?, ?, ?, 'IN_FLIGHT', 'JOURNAL_PACK', ?, ?)",
                    put, scope, scope, job.archive(), job.tenant(), job.workspace(), job.session(), resource, ManagedSchemaKeys.key(request), request, now(), now());
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, resource_id, gmt_create)"
                    + " VALUES (?, 'OPERATION', ?, ?, ?, ?, ?, ?, ?, ?)", scope, job.archive(), job.epoch(), resource, job.tenant(), job.workspace(), job.session(), id, now());
            return true;
        }));
        if (create) {
            try {
                objects.putIfAbsent(pack.key(), new ByteArrayInputStream(bytes), bytes.length, () -> check(job, "HOT"));
                jdbc.update("UPDATE ma_operation SET state = 'RETURNED', gmt_modified = ? WHERE target_key = ? AND operation_id = ? AND operation_kind = 'OBJECT_PUT' AND phase = 'JOURNAL_PACK' AND state = 'IN_FLIGHT'",
                        now(), resource, job.archive());
            } catch (ObjectStorageException failure) {
                if (failure.reason() != ObjectStorageException.Reason.ALREADY_EXISTS) {
                    jdbc.update("UPDATE ma_operation_work SET state = 'UNKNOWN', gmt_modified = ? WHERE operation_key = ? AND target_key = ? AND state = 'IN_FLIGHT'",
                            now(), job.archive(), resource);
                    jdbc.update("UPDATE ma_operation SET state = 'UNKNOWN', gmt_modified = ? WHERE target_key = ? AND operation_id = ? AND operation_kind = 'OBJECT_PUT' AND phase = 'JOURNAL_PACK' AND state = 'IN_FLIGHT'",
                            now(), resource, job.archive());
                    throw SessionResourceBodies.unavailable();
                }
            }
        }
        return pack;
    }

    private List<JournalPackCodec.Record> verifyPack(Job job, Pack pack, String residency, long deadline) {
        if (!objects.identity().equals(pack.store())) {
            throw SessionResourceBodies.unavailable();
        }
        Runnable guard = () -> {
            if (System.nanoTime() > deadline) {
                throw JournalResidencyGuard.rehydrating();
            }
            check(job, residency);
        };
        try (InputStream stream = objects.open(pack.key(), pack.length() + 1, guard)) {
            byte[] bytes = SessionResourceBodies.verifiedBytes(stream, pack.length(), pack.digest(), guard);
            var records = JournalPackCodec.decode(bytes, pack.first(), pack.last(), guard);
            transactions.executeWithoutResult(status -> {
                lock(job, residency);
                jdbc.update("UPDATE ma_operation_work SET state = 'VERIFIED', gmt_modified = ? WHERE operation_key = ? AND target_key = ? AND state IN ('IN_FLIGHT','UNKNOWN')", now(), job.archive(), pack.resource());
                jdbc.update("UPDATE ma_resource SET state = 'REFERENCED', last_verified_at = ? WHERE resource_key = ? AND state = 'ALLOCATED'", now(), pack.resource());
                jdbc.update("UPDATE ma_operation SET state = 'RETURNED', completed_at = ?, gmt_modified = ? WHERE target_key = ? AND operation_id = ? AND operation_kind = 'OBJECT_PUT' AND phase = 'JOURNAL_PACK' AND state IN ('IN_FLIGHT','UNKNOWN','RETURNED')",
                        now(), now(), pack.resource(), job.archive());
            });
            return records;
        } catch (IOException | ObjectStorageException failure) {
            throw SessionResourceBodies.unavailable();
        }
    }

    private void writeBodies(Job job, List<JournalPackCodec.Record> records, boolean hydrate, long deadline) {
        for (int offset = 0; offset < records.size(); offset += 32) {
            if (System.nanoTime() > deadline) {
                throw JournalResidencyGuard.rehydrating();
            }
            var batch = records.subList(offset, Math.min(records.size(), offset + 32));
            transactions.executeWithoutResult(status -> {
                lock(job, hydrate ? "HYDRATING" : "EVICTING");
                if (!hydrate && ToolPublicationRetentionStore.earliestReadLeaseExpiry(jdbc, job.tenant(), job.session()) != 0) {
                    throw JournalResidencyGuard.rehydrating();
                }
                for (var record : batch) {
                    var row = jdbc.queryForMap("SELECT byte_length, record_digest, record_bytes FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision = ? FOR UPDATE",
                            job.tenant(), job.session(), record.revision());
                    if (number(row, "byte_length") != record.bytes().length || !record.digest().equals(row.get("record_digest"))
                            || row.get("record_bytes") != null && !Arrays.equals(record.bytes(), (byte[]) row.get("record_bytes"))) {
                        throw JournalStoreRows.journalCorrupt();
                    }
                    jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ? WHERE tenant_id = ? AND session_id = ? AND journal_revision = ?",
                            hydrate ? record.bytes() : null, job.tenant(), job.session(), record.revision());
                }
                if (hydrate) {
                    jdbc.update("UPDATE ma_operation SET result_json = ?, gmt_modified = ? WHERE operation_key = ? AND operation_kind = 'JOURNAL_HYDRATE'",
                            json.createObjectNode().put("through", batch.getLast().revision()).toString(), now(), job.operation());
                }
            });
        }
    }

    private List<Pack> manifest(Job job) {
        var operation = operation(job.archive());
        JsonNode result = JdbcManagedToolResultStore.parse((String) operation.get("result_json"));
        int count = result.path("packCount").asInt(-1);
        var packs = jdbc.query("SELECT payload_json FROM ma_operation_work WHERE operation_key = ? AND work_kind = 'RESOURCE' AND state = 'VERIFIED' ORDER BY revision",
                (row, index) -> parsePack(row.getString(1)), job.archive());
        if (count < 1 || packs.size() != count) {
            throw JournalStoreRows.journalCorrupt();
        }
        long last = 0;
        String digest = "";
        for (Pack pack : packs) {
            if (pack.first() != last + 1 || pack.last() < pack.first()) {
                throw JournalStoreRows.journalCorrupt();
            }
            digest = DigestUtils.sha256Hex(digest + ":" + pack.first() + ":" + pack.last() + ":" + pack.digest());
            last = pack.last();
        }
        if (last != job.revision() || !digest.equals(result.path("manifestDigest").asText())) {
            throw JournalStoreRows.journalCorrupt();
        }
        return packs;
    }

    private boolean eligible(String tenant, String session, Map<String, Object> head) {
        var root = jdbc.queryForMap("SELECT status, session_kind, retired_at, is_csi_guard, is_recovery_protected, gmt_modified FROM ma_session WHERE tenant_id = ? AND session_id = ?", tenant, session);
        if (!List.of("CLOSED", "ARCHIVED").contains(root.get("status")) || !"PUBLIC".equals(root.get("session_kind"))
                || root.get("retired_at") != null || ToolPublicationRetentionStore.flag(root, "is_csi_guard")
                || ToolPublicationRetentionStore.flag(root, "is_recovery_protected") || !"SEALED".equals(head.get("state"))
                || !"READY".equals(head.get("recovery_status")) || !"released".equals(head.get("activation_phase"))
                || !List.of("HOT", "EVICTING").contains(head.get("journal_residency"))
                || number(head, "gmt_modified") > now() - COOLING_MILLIS || number(root, "gmt_modified") > now() - COOLING_MILLIS
                || ToolPublicationRetentionStore.earliestReadLeaseExpiry(jdbc, tenant, session) != 0
                || SessionObjectMaintenance.recoveryInFlight(jdbc, tenant, session)) {
            return false;
        }
        if (!jdbc.queryForList("SELECT 1 FROM ma_turn WHERE tenant_id = ? AND session_id = ? AND status IN ('ACCEPTED','RUNNING','CANCELLING') LIMIT 1", Integer.class, tenant, session).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_tool_execution e JOIN ma_runtime_binding b ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND e.harness_session_id = ? AND e.execution_state NOT IN ('SETTLED','ABANDONED') LIMIT 1", Integer.class, tenant, session).isEmpty()
                || !jdbc.queryForList("SELECT 1 FROM ma_operation WHERE tenant_id = ? AND session_id = ? AND operation_kind NOT IN ('JOURNAL_ARCHIVE','JOURNAL_HYDRATE')"
                        + " AND NOT (operation_kind = 'TOOL_RESULT_PROJECTION' AND state IN ('READY','UNSUPPORTED','SUPPRESSED','QUARANTINED'))"
                        + " AND state NOT IN ('SUCCEEDED','FAILED','RETURNED','COMPLETED','CANCELLED','ABORTED','INVALIDATED','done','orphaned') LIMIT 1", Integer.class, tenant, session).isEmpty()) {
            return false;
        }
        return jdbc.queryForObject("SELECT COALESCE(SUM(byte_length), 0) FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session) >= MIN_BYTES;
    }

    private void check(Job job, String... residency) {
        var head = head(job.tenant(), job.session());
        if (head == null || !List.of(residency).contains(head.get("journal_residency")) || number(head, "journal_archive_epoch") != job.epoch()
                || !job.archive().equals(head.get("journal_archive_operation_key")) || number(head, "journal_revision") != job.revision()
                || number(head, "writer_generation") != job.generation()
                || number(head, "committed_sequence") != job.sequence() || !Objects.equals(job.digest(), head.get("last_commit_digest"))) {
            throw JournalResidencyGuard.rehydrating();
        }
        var retired = jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?", Long.class, job.tenant(), job.session());
        if (retired != null && !SessionObjectMaintenance.recoveryInFlight(jdbc, job.tenant(), job.session())) {
            throw JournalResidencyGuard.rehydrating();
        }
    }

    private void lock(Job job, String... residency) {
        ToolPublicationRetentionStore.lockSessionHead(jdbc, job.tenant(), job.session());
        check(job, residency);
    }

    private void releaseRedundantPacks() {
        var operations = jdbc.query("SELECT operation_key, tenant_id, session_id FROM ma_operation WHERE operation_kind = 'JOURNAL_ARCHIVE' AND state = 'SUCCEEDED' AND phase = 'HOT' AND completed_at <= ? LIMIT 8",
                (row, index) -> ManagedSchemaRows.read(row), now() - RETAIN_MILLIS);
        for (var operation : operations) {
            transactions.executeWithoutResult(status -> {
                String tenant = (String) operation.get("tenant_id");
                String session = (String) operation.get("session_id");
                String key = (String) operation.get("operation_key");
                ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
                var head = head(tenant, session);
                if (head != null && !"HOT".equals(head.get("journal_residency"))) {
                    return;
                }
                jdbc.update("UPDATE ma_session_head SET journal_archive_operation_key = NULL WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION' AND journal_archive_operation_key = ?", tenant, session, key);
                jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'OPERATION' AND owner_key = ?", key);
                jdbc.update("UPDATE ma_operation SET phase = 'RETIRED', gmt_modified = ? WHERE operation_key = ? AND phase = 'HOT'", now(), key);
            });
        }
    }

    private Map<String, Object> head(String tenant, String session) {
        return jdbc.query("SELECT workspace_id, state, recovery_status, activation_phase, journal_revision, committed_sequence, last_commit_digest, writer_generation, gmt_modified, journal_residency, journal_archive_epoch, journal_archive_operation_key"
                + " FROM ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'", (row, index) -> ManagedSchemaRows.read(row), tenant, session)
                .stream().findFirst().orElse(null);
    }

    private Job job(Map<String, Object> head, String archive, String operation, long epoch) {
        var owner = operation(archive);
        var request = JdbcManagedToolResultStore.parse((String) owner.get("request_json"));
        if (!sameCut(head, request)) {
            throw JournalResidencyGuard.rehydrating();
        }
        return new Job((String) owner.get("tenant_id"), (String) owner.get("workspace_id"), (String) owner.get("session_id"), archive, operation,
                epoch, request.path("revision").asLong(), request.path("sequence").asLong(),
                request.path("commitDigest").isNull() ? null : request.path("commitDigest").asText(), request.path("writerGeneration").asLong());
    }

    private boolean sameCut(Map<String, Object> head, JsonNode request) {
        return number(head, "journal_revision") == request.path("revision").asLong(-1)
                && number(head, "committed_sequence") == request.path("sequence").asLong(-1)
                && number(head, "writer_generation") == request.path("writerGeneration").asLong(-1)
                && Objects.equals(head.get("last_commit_digest"), request.path("commitDigest").isNull() ? null : request.path("commitDigest").asText());
    }

    private void invalidateChangedCuts() {
        var pending = jdbc.query("SELECT o.operation_key, o.tenant_id, o.session_id FROM ma_operation o JOIN ma_session_head h ON h.tenant_id = o.tenant_id AND h.session_id = o.session_id AND h.head_kind = 'MANAGED_SESSION'"
                + " WHERE o.operation_kind = 'JOURNAL_ARCHIVE' AND o.phase IN ('PACKING','PACKED') AND h.journal_residency = 'HOT' AND o.operation_key > ? ORDER BY o.operation_key LIMIT 32", (row, index) -> ManagedSchemaRows.read(row), invalidationCursor);
        for (var entry : pending) {
            invalidationCursor = (String) entry.get("operation_key");
            transactions.executeWithoutResult(status -> {
                String tenant = (String) entry.get("tenant_id");
                String session = (String) entry.get("session_id");
                String key = (String) entry.get("operation_key");
                ToolPublicationRetentionStore.lockSessionHead(jdbc, tenant, session);
                var current = head(tenant, session);
                if (current == null || !"HOT".equals(current.get("journal_residency"))) {
                    return;
                }
                var request = JdbcManagedToolResultStore.parse((String) operation(key).get("request_json"));
                if (key.equals(current.get("journal_archive_operation_key")) && sameCut(current, request)
                        && jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?", Long.class, tenant, session) == null) {
                    return;
                }
                jdbc.update("UPDATE ma_session_head SET journal_archive_epoch = journal_archive_epoch + 1, journal_archive_operation_key = NULL WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION' AND journal_archive_operation_key = ?", tenant, session, key);
                jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED', phase = 'HOT', completed_at = ?, gmt_modified = ? WHERE operation_key = ? AND phase IN ('PACKING','PACKED')", now(), now(), key);
            });
        }
        if (pending.size() < 32) {
            invalidationCursor = "";
        }
    }

    private void verifyChain(Job job) {
        long revision = 0;
        long sequence = 0;
        String digest = null;
        while (revision < job.revision()) {
            var page = jdbc.query("SELECT journal_revision, first_sequence, last_sequence, event_count, previous_commit_digest, commit_digest, record_encoding FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? AND journal_revision <= ? ORDER BY journal_revision LIMIT 256",
                    (row, index) -> ManagedSchemaRows.read(row), job.tenant(), job.session(), revision, job.revision());
            if (page.isEmpty()) {
                throw JournalStoreRows.journalCorrupt();
            }
            for (var row : page) {
                long count = number(row, "event_count");
                if (number(row, "journal_revision") != ++revision || !"identity".equals(row.get("record_encoding"))
                        || !Objects.equals(digest, row.get("previous_commit_digest"))
                        || number(row, "first_sequence") != (count == 0 ? sequence : sequence + 1)
                        || number(row, "last_sequence") != sequence + count) {
                    throw JournalStoreRows.journalCorrupt();
                }
                sequence += count;
                digest = (String) row.get("commit_digest");
            }
        }
        if (sequence != job.sequence() || !Objects.equals(digest, job.digest())) {
            throw JournalStoreRows.journalCorrupt();
        }
    }

    private Map<String, Object> operation(String key) {
        return jdbc.query("SELECT tenant_id, workspace_id, session_id, state, phase, request_json, result_json, target_revision FROM ma_operation WHERE operation_key = ?",
                (row, index) -> ManagedSchemaRows.read(row), key).getFirst();
    }

    private List<Map<String, Object>> work(Job job, String resource) {
        return jdbc.queryForList("SELECT state, payload_json FROM ma_operation_work WHERE operation_key = ? AND work_kind = 'RESOURCE' AND target_key = ? FOR UPDATE", job.archive(), resource);
    }

    private void createOperation(String key, String tenant, String session, String workspace, String kind, long revision, String request) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, operation_kind, tenant_id, workspace_id, session_id, target_kind, target_key, target_revision, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SESSION', ?, ?, ?, ?, 'RUNNING', 'PACKING', ?, ?) ON DUPLICATE KEY UPDATE operation_key = operation_key",
                key, scope, scope, key, kind, tenant, workspace, session, scope, revision, ManagedSchemaKeys.key(request), request, now(), now());
    }

    private Pack parsePack(String encoded) {
        try {
            return json.readValue(encoded, Pack.class);
        } catch (IOException failure) {
            throw JournalStoreRows.journalCorrupt();
        }
    }

    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (IOException failure) {
            throw new IllegalStateException(failure);
        }
    }

    private long now() {
        return ToolPublicationRetentionStore.now(jdbc);
    }

    private static long number(Map<String, Object> row, String name) {
        return ((Number) row.get(name)).longValue();
    }

    private record Job(String tenant, String workspace, String session, String archive, String operation,
            long epoch, long revision, long sequence, String digest, long generation) { }

    private record Pack(String resource, String key, String store, long length, String digest, long first, long last) { }
}
