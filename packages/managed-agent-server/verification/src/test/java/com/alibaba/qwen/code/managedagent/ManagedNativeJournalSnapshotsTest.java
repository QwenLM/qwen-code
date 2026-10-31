package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots.PublishRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.util.Base64;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedNativeJournalSnapshotsTest {
    private static final String TENANT = "snapshot-tenant";
    private static final String WORKSPACE = "snapshot-workspace";
    private static final String SESSION = "snapshot-session";
    private static final String WRITER = "writer-extension";
    private static final String TOKEN = "extension-writer-token-0123456789";
    private static final ObjectMapper JSON = new ObjectMapper();
    protected FaultJdbc jdbc;
    protected TransactionTemplate tx;
    protected ManagedSessionStore sessions;
    protected ManagedNativeJournalSnapshots snapshots;
    private ExtensionRecordJournal journal;

    protected DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:native-snapshots-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new FaultJdbc(source);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        sessions = com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedSessionStore(jdbc));
        snapshots = new ManagedNativeJournalSnapshots(jdbc, sessions, JSON);
        journal = new ExtensionRecordJournal(sessions, TENANT, WORKSPACE, SESSION);
        tx.executeWithoutResult(status -> journal.open());
    }

    @Test
    void selectsOnlyPublishedSnapshotsAtOrBeforeTheFrozenHead() {
        var firstHead = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        assertThat(snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN, firstHead)).isNull();
        var first = snapshots.publish(TENANT, SESSION, TOKEN, request("first"));
        var tied = snapshots.publish(TENANT, SESSION, TOKEN, request("tie"));
        String expected = java.util.List.of(first, tied).stream()
                .min(java.util.Comparator.comparing(value -> value.manifest().resourceId()))
                .orElseThrow().snapshot().snapshotId();
        assertThat(snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN, firstHead).snapshot().snapshotId()).isEqualTo(expected);
        commitMonitor();
        var latest = snapshots.publish(TENANT, SESSION, TOKEN, request("latest"));
        assertThat(snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN,
                sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN)).snapshot()).isEqualTo(latest.snapshot());
        assertThat(snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN, firstHead).snapshot().snapshotId()).isEqualTo(expected);
        assertThatThrownBy(() -> snapshots.select(TENANT, WORKSPACE, SESSION, "wrong-token", firstHead))
                .isInstanceOf(ManagedAgentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {".", "..", "folder/snapshot", "folder\\snapshot"})
    void leavesNamesThatTheHttpRouteCannotAddressUnselected(String id) {
        snapshots.publish(TENANT, SESSION, TOKEN, request(id));
        assertThat(snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN,
                sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN))).isNull();
    }

    @Test
    void aSelectedOwnerMissingItsRootFailsInsteadOfFallingBack() {
        snapshots.publish(TENANT, SESSION, TOKEN, request("older"));
        commitMonitor();
        var latest = snapshots.publish(TENANT, SESSION, TOKEN, request("latest"));
        jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'NATIVE_SNAPSHOT' AND resource_id = ?",
                latest.manifest().resourceId());
        assertThatThrownBy(() -> snapshots.select(TENANT, WORKSPACE, SESSION, TOKEN,
                sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN)))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("managed_session_snapshot_corrupt"));
    }

    @Test
    void ordinaryPublicationCannotTakeANativeManifestLock() {
        byte[] bytes = new byte[] {1};
        var request = new ManagedSessionStoreModels.PublishToolResultRequest(WORKSPACE, WRITER, 1,
                "managed-native-journal-snapshot:reserved", "managed-tool-result-content", 1, bytes.length,
                org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes), Base64.getEncoder().encodeToString(bytes));
        assertThatThrownBy(() -> tx.execute(status -> sessions.publishToolResult(TENANT, SESSION, TOKEN, request)))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("invalid_managed_session_store_request"));
        var inherited = new ManagedSessionStoreModels.StoredResource(request.resourceId(), "managed-extension-config-bundle",
                1, bytes.length, request.digest(), bytes);
        assertThatThrownBy(() -> tx.execute(status -> sessions.publishInheritedExtensionResource(TENANT, WORKSPACE, SESSION, inherited)))
                .isInstanceOf(ManagedAgentException.class).satisfies(error ->
                        assertThat(((ManagedAgentException) error).getCode()).isEqualTo("invalid_managed_session_store_request"));
    }

    @Test
    void freeFormCancelTargetIsNotAResourceDependency() {
        var target = JSON.createObjectNode().put("resourceId", "user-data").put("kind", "example").put("digest", "abc");
        var request = journal.requestOrdinary("cancel-json", "opaque", JSON.createObjectNode(), event -> {
            event.put("kind", "cancel.requested");
            event.putObject("payload").put("requestId", "cancel-json").put("reason", "test")
                    .put("requestedBy", "actor").set("target", target);
        }, records -> records, 0);
        tx.executeWithoutResult(status -> journal.commit(request));
        var published = snapshots.publish(TENANT, SESSION, TOKEN, request("free-json"));
        assertThat(published.snapshot().pageCount()).isEqualTo(2);
        assertThat(snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "free-json", 0, 100).pages()).hasSize(2);
    }

    @Test
    void aPreexistingOrdinaryResourceCannotBeOverwrittenByAManifestClaim() {
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        String id = "managed-native-journal-snapshot:"
                + com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(scope, "collision");
        byte[] bytes = "ordinary".getBytes(java.nio.charset.StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 1)",
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(scope, id), scope, TENANT, WORKSPACE, SESSION, id, "managed-input",
                bytes.length, org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes), bytes);
        assertThatThrownBy(() -> snapshots.publish(TENANT, SESSION, TOKEN, request("collision")))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_id = ?", byte[].class, id))
                .isEqualTo(bytes);
    }

    @Test
    void immutablePagesPreserveCommandReplayAndResourcesAcrossAppendAndReopen() throws Exception {
        commitMonitor();
        var before = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        var original = tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("first")));
        assertThat(original.snapshot().pageCount()).isEqualTo(2);
        assertThat(original.snapshot().resourceCount()).isPositive();
        assertThat(sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN)).isEqualTo(before);
        var first = snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "first", 0, 1);
        assertThat(first.pages()).hasSize(1);
        assertThat(first.hasMore()).isTrue();
        var tail = snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "first", first.nextRevision(), 100);
        assertThat(tail.hasMore()).isFalse();
        JsonNode page = JSON.readTree(Base64.getDecoder().decode(tail.pages().getFirst().bytesBase64()));
        assertThat(page.path("transaction").path("commandId").asText()).isEqualTo("snapshot-monitor");
        assertThat(page.path("transaction").path("recordBytesBase64").asText())
                .isEqualTo(sessions.transactions(TENANT, WORKSPACE, SESSION, TOKEN, 1, 1)
                        .transactions().getFirst().recordBytesBase64());
        assertThat(tail.pages().getFirst().resource().digest()).isEqualTo(original.snapshot().lastPageDigest());
        var old = request("first");
        var resource = ManagedExtensionProjectionContractTest.fixtures().required("monitorChainCases")
                .get(0).required("revisions").get(1);
        tx.executeWithoutResult(status -> journal.commitMonitor("snapshot-next", resource.required("monitorRun"),
                resource.required("occurredAt").longValue()));
        assertThat(tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, old)).replayed()).isTrue();
        assertThat(new ManagedNativeJournalSnapshots(jdbc, sessions, JSON)
                .read(TENANT, WORKSPACE, SESSION, TOKEN, "first").snapshot()).isEqualTo(original.snapshot());
        assertThat(tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("second")))
                .snapshot().pageCount()).isEqualTo(3);
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("first"))))
                .isInstanceOf(ManagedAgentException.class).hasMessageContaining("refused");
    }

    @Test
    void snapshotReadsUseIndependentPagesAfterOriginalTransactionsAreUnavailable() {
        commitMonitor();
        tx.executeWithoutResult(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("independent")));
        jdbc.update("DELETE FROM ma_session_journal_tx WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);
        var restored = snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "independent", 0, 100);
        assertThat(restored.pages()).hasSize(2);
        assertThat(restored.nextRevision()).isEqualTo(2);
    }

    @Test
    void staleHeadAndWriterCannotPublishAndTakeoverCanReadOldSnapshot() {
        var request = request("writer");
        var stale = new PublishRequest(WORKSPACE, WRITER, 1, "stale", 2, 0, null);
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, stale)))
                .isInstanceOf(ManagedAgentException.class);
        tx.executeWithoutResult(status -> snapshots.publish(TENANT, SESSION, TOKEN, request));
        tx.executeWithoutResult(status -> sessions.sealWriter(TENANT, SESSION, TOKEN,
                new ManagedSessionStoreModels.SealWriterRequest(WORKSPACE, WRITER, 1)));
        String nextToken = "snapshot-second-writer-0123456789012";
        var grant = tx.execute(status -> sessions.acquireWriter(TENANT, SESSION, nextToken,
                new ManagedSessionStoreModels.AcquireWriterRequest(WORKSPACE, "second-writer", 60_000L)));
        assertThat(grant.writerGeneration()).isEqualTo(2);
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request)))
                .isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> snapshots.read(TENANT, WORKSPACE, SESSION, TOKEN, "writer"))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(snapshots.read(TENANT, WORKSPACE, SESSION, nextToken, "writer").snapshot().coveredJournalRevision())
                .isEqualTo(1);
    }

    @Test
    void wrongSequenceDigestAndScopeFailClosed() {
        for (PublishRequest bad : new PublishRequest[] {
            new PublishRequest(WORKSPACE, WRITER, 1, "sequence", 1, 1, null),
            new PublishRequest(WORKSPACE, WRITER, 1, "digest", 1, 0, "a".repeat(64)),
            new PublishRequest("foreign-workspace", WRITER, 1, "scope", 1, 0, null),
            new PublishRequest(WORKSPACE, WRITER, 2, "generation", 1, 0, null)
        }) {
            assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, bad)))
                    .isInstanceOf(ManagedAgentException.class);
        }
        assertThat(snapshotPins()).isZero();
    }

    @ParameterizedTest
    @ValueSource(strings = {"INSERT INTO ma_resource (", "INSERT INTO ma_resource_ref ("})
    void persistenceFailureRollsBackEveryNewSnapshotRow(String boundary) {
        commitMonitor();
        long resources = jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class);
        jdbc.boundary = boundary;
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("atomic"))))
                .isInstanceOf(SimulatedCrash.class);
        assertThat(jdbc.injected).isTrue();
        assertThat(snapshotPins()).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class)).isEqualTo(resources);
        jdbc.boundary = null;
        var retried = tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("atomic")));
        assertThat(retried).isNotNull();
    }

    @Test
    void leaseExpiringAfterManifestInsertCannotPublish() {
        jdbc.expireOnManifest = true;
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("expired"))))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.injected).isTrue();
        assertThat(snapshotPins()).isZero();
    }

    @Test
    void missingAndCorruptResourcesCannotProduceASnapshot() {
        commitMonitor();
        String id = jdbc.queryForObject("SELECT resource_id FROM ma_resource WHERE kind = ?", String.class, "managed-monitor_run");
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE resource_id = ?", new byte[] {0}, id);
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("corrupt"))))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(snapshotPins()).isZero();
    }

    @Test
    void missingCensusReferenceIsRejectedEvenWhenAnotherProjectionPinsItsBody() {
        commitMonitor();
        jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'JOURNAL' AND resource_id IN"
                + " (SELECT resource_id FROM ma_resource WHERE kind = ?)", "managed-monitor_run");
        assertThatThrownBy(() -> tx.execute(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("missing"))))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(snapshotPins()).isZero();
    }

    @Test
    void corruptOrMissingPageAndPinsAreNeverEndOfStream() {
        tx.executeWithoutResult(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("damaged")));
        String page = snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "damaged", 0, 1)
                .pages().getFirst().resource().resourceId();
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE resource_id = ?", new byte[] {0}, page);
        assertThatThrownBy(() -> snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "damaged", 0, 1))
                .isInstanceOf(ManagedAgentException.class);
        jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'NATIVE_SNAPSHOT' AND resource_id = ?", page);
        assertThatThrownBy(() -> snapshots.read(TENANT, WORKSPACE, SESSION, TOKEN, "damaged"))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void paginationBoundsAndExhaustedCursorAreExplicit() {
        tx.executeWithoutResult(status -> snapshots.publish(TENANT, SESSION, TOKEN, request("pages")));
        assertThat(snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "pages", 1, 1).pages()).isEmpty();
        for (long cursor : new long[] {-1, 2}) {
            assertThatThrownBy(() -> snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "pages", cursor, 1))
                    .isInstanceOf(ManagedAgentException.class);
        }
        for (int limit : new int[] {0, 101}) {
            assertThatThrownBy(() -> snapshots.pages(TENANT, WORKSPACE, SESSION, TOKEN, "pages", 0, limit))
                    .isInstanceOf(ManagedAgentException.class);
        }
    }

    protected PublishRequest request(String id) {
        var head = sessions.restore(TENANT, WORKSPACE, SESSION, TOKEN);
        return new PublishRequest(WORKSPACE, WRITER, head.writerGeneration(), id,
                head.journalRevision(), head.committedSequence(), head.lastCommitDigest());
    }

    protected void commitMonitor() {
        JsonNode revision;
        try {
            revision = ManagedExtensionProjectionContractTest.fixtures().required("monitorChainCases")
                    .get(0).required("revisions").get(0);
        } catch (java.io.IOException error) {
            throw new java.io.UncheckedIOException(error);
        }
        tx.executeWithoutResult(status -> journal.commitMonitor("snapshot-monitor", revision.required("monitorRun"),
                revision.required("occurredAt").longValue()));
    }

    protected void commitNextMonitor() throws java.io.IOException {
        var revision = ManagedExtensionProjectionContractTest.fixtures().required("monitorChainCases")
                .get(0).required("revisions").get(1);
        tx.executeWithoutResult(status -> journal.commitMonitor("snapshot-concurrent-next", revision.required("monitorRun"),
                revision.required("occurredAt").longValue()));
    }

    protected long snapshotPins() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'NATIVE_SNAPSHOT'", Long.class);
    }

    private static final class SimulatedCrash extends RuntimeException { }

    protected static class FaultJdbc extends ManagedSchemaJdbcTemplate {
        String boundary;
        boolean expireOnManifest;
        boolean injected;
        Runnable afterPage;
        int pagesBeforePause;

        FaultJdbc(DataSource source) {
            super(source);
        }

        @Override
        public int update(String sql, Object... arguments) {
            int changed = super.update(sql, arguments);
            if (boundary != null && sql.startsWith(boundary)) {
                injected = true;
                throw new SimulatedCrash();
            }
            if (afterPage != null && sql.startsWith("INSERT INTO ma_resource (")
                    && java.util.Arrays.asList(arguments).contains("managed-native-journal-snapshot-page")
                    && pagesBeforePause-- == 0) {
                Runnable callback = afterPage;
                afterPage = null;
                callback.run();
            }
            if (expireOnManifest && sql.startsWith("UPDATE ma_resource SET")
                    && java.util.Arrays.asList(arguments).contains("managed-native-journal-snapshot")) {
                injected = true;
                super.update("UPDATE ma_session_head SET writer_lease_until = 0 WHERE tenant_id = ? AND session_id = ?",
                        TENANT, SESSION);
            }
            return changed;
        }
    }
}
