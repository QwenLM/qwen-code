package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.DefaultTransactionDefinition;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertThrows;

class WorkspaceLifecycleMySqlIT extends WorkspaceLifecycleStoreTest {
    private DriverManagerDataSource source;
    private JdbcTemplate admin;
    private String schema;

    @BeforeEach
    void openSchema() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user", "root");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "l3_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @Override
    Fixture fixture() {
        return new Fixture(source);
    }

    @Test
    void lifecycleEffectsKeepOtherTenantExtensionRecordsUnlocked() throws Exception {
        var fixture = fixture();
        String scope = ManagedSessionStore.sessionScopeKey("neighbor", "other-session");
        String record = ManagedExtensionProjection.recordKey("other-session", "hook_execution", "other-hook");
        fixture.jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id,"
                + " session_id, domain, record_id, operation_hash, revision, record_resource_id, gmt_create, first_sequence)"
                + " VALUES (?, ?, 'neighbor', 'other-workspace', 'other-session', 'hook_execution', 'other-hook', ?, 1, 'other-resource', 1, 1)",
                scope, record, "a".repeat(64));
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var workers = Executors.newFixedThreadPool(2)) {
            var held = workers.submit(() -> fixture.transactions.execute(ignored -> {
                try {
                    new WorkspaceLifecycleStoreTest() {
                        @Override
                        Fixture fixture() {
                            return fixture;
                        }
                    }.hookReceiptsUseCompactProtocolIdentitiesWithAnIndentedApplicationMapper(OperationKind.DELETE, true);
                    entered.countDown();
                    if (!release.await(10, TimeUnit.SECONDS)) {
                        throw new AssertionError("Lifecycle hold was not released");
                    }
                    return null;
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            }));
            try {
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
                var neighbor = workers.submit(() -> new JdbcTemplate(source).update(
                        "UPDATE ma_session_record SET revision = revision + 1 WHERE session_scope_key = ? AND record_key = ?",
                        scope, record));
                assertThat(neighbor.get(2, TimeUnit.SECONDS)).isEqualTo(1);
            } finally {
                release.countDown();
            }
            held.get(10, TimeUnit.SECONDS);
        }
        assertThat(fixture.jdbc.queryForObject("SELECT revision FROM ma_session_record"
                + " WHERE session_scope_key = ? AND record_key = ?", Long.class, scope, record)).isEqualTo(2);
    }

    @ParameterizedTest
    @MethodSource("legacyCloseClockZones")
    @ResourceLock("java.util.TimeZone")
    void legacyCloseUsesTheDatabaseEpochAcrossTimeZones(String jvmZone, String databaseZone, String connectionZone) {
        TimeZone previous = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone(jvmZone));
            String url = source.getUrl();
            source.setUrl(url + (url.contains("?") ? "&" : "?")
                    + "connectionTimeZone=" + URLEncoder.encode(connectionZone, StandardCharsets.UTF_8)
                    + "&sessionVariables=" + URLEncoder.encode("time_zone='" + databaseZone + "'", StandardCharsets.UTF_8));
            var fixture = fixture();
            var journal = new ManagedSessionStore(fixture.jdbc);
            var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                    "w".repeat(32), new AcquireWriterRequest("workspace", "original", 60_000L)));
            String id = fixture.transactions.execute(ignored -> fixture.store.beginWorkspaceLifecycle("tenant", fixture.session,
                    OperationKind.CLOSE, "owner", "a".repeat(64), "legacy", "digest", true).operation().operationId());
            var operation = fixture.transactions.execute(ignored -> fixture.store.claimOperation("tenant", fixture.session,
                    id, "worker", Duration.ofMinutes(1)).orElseThrow());
            fixture.bindings.requestHarnessDrain("tenant", fixture.session);
            var legacy = new AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration(), "legacy-close");
            var ordinary = new AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration());
            var execution = new WorkspaceExecutionStore(fixture.jdbc, new DataSourceTransactionManager(source));
            assertThat(operation.lifecycleProtocolVersion()).isZero();
            assertThat(fixture.transactions.<Boolean>execute(ignored -> WorkspaceLifecycleStore.legacyClose(fixture.jdbc, "tenant", fixture.session)))
                    .isTrue();
            fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary("tenant", fixture.session, "w".repeat(32), legacy));
            execution.authorizeLegacyClose(fixture.store.requireSession("tenant", fixture.session));
            assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary(
                    "tenant", fixture.session, "w".repeat(32), ordinary))).isInstanceOfSatisfying(ApiException.class,
                            error -> assertThat(error.getCode()).isEqualTo("managed_session_lifecycle_active"));
            fixture.jdbc.update("UPDATE ma_operation SET claim_until = " + ManagedSchemaTime.SQL_NOW + " - 1000 WHERE operation_id = ?", id);
            assertThat(fixture.transactions.<Boolean>execute(ignored -> WorkspaceLifecycleStore.legacyClose(fixture.jdbc, "tenant", fixture.session)))
                    .isFalse();
            assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary(
                    "tenant", fixture.session, "w".repeat(32), legacy))).isInstanceOfSatisfying(ApiException.class,
                            error -> assertThat(error.getCode()).isEqualTo("managed_session_lifecycle_active"));
            assertThatThrownBy(() -> execution.authorizeLegacyClose(fixture.store.requireSession("tenant", fixture.session)))
                    .hasMessageContaining("unavailable");
        } finally {
            TimeZone.setDefault(previous);
        }
    }

    static Stream<Arguments> legacyCloseClockZones() {
        return Stream.of(new String[]{"Asia/Shanghai", "+00:00"}, new String[]{"UTC", "+08:00"})
                .flatMap(zones -> List.of("LOCAL", "UTC", "+08:00", "Asia/Shanghai").stream()
                        .map(connection -> Arguments.of(zones[0], zones[1], connection)));
    }

    @Test
    void admissionSerializesAnOrdinaryWriterOnThePlacementFence() throws Exception {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var entered = new CountDownLatch(1);
            var queued = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<Throwable>>();
            fixture.transactions.execute(ignored -> {
                WorkspaceLifecycleStore.lockPlacement(fixture.jdbc, "tenant");
                queued.set(pool.submit(() -> {
                    entered.countDown();
                    try {
                        fixture.transactions.execute(transaction -> journal.acquireWriter("tenant", fixture.session,
                                "w".repeat(32), new AcquireWriterRequest("workspace", "late-writer", 60_000L)));
                        return null;
                    } catch (RuntimeException error) {
                        return error;
                    }
                }));
                try {
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThrows(TimeoutException.class, () -> queued.get().get(100, TimeUnit.MILLISECONDS));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return fixture.admit(OperationKind.DELETE);
            });
            assertThat(queued.get().get(5, TimeUnit.SECONDS)).isInstanceOf(ApiException.class);
        }
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head WHERE head_kind = 'MANAGED_SESSION'", Integer.class)).isZero();
    }

    @Test
    void ordinaryAuthorizationFencesOnlyWithinOneSession() throws Exception {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        String token = "w".repeat(32);
        String otherTenant = "other-tenant";
        String otherSession = "other-session";
        var original = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                token, new AcquireWriterRequest("workspace", "writer", 60_000L)));
        var neighbor = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", "neighbor-session",
                token, new AcquireWriterRequest("workspace", "writer", 60_000L)));
        var other = fixture.transactions.execute(ignored -> journal.acquireWriter(otherTenant, otherSession,
                token, new AcquireWriterRequest("workspace", "writer", 60_000L)));
        fixture.bindings.requestHarnessDrain("unrelated-tenant", "unrelated-session");
        var originalRequest = new AuthorizeLifecycleRequest("workspace", "writer", original.writerGeneration());
        var neighborRequest = new AuthorizeLifecycleRequest("workspace", "writer", neighbor.writerGeneration());
        var otherRequest = new AuthorizeLifecycleRequest("workspace", "writer", other.writerGeneration());
        var sameSession = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<?>>();
        try (var pool = Executors.newFixedThreadPool(3)) {
            var entered = new CountDownLatch(2);
            var sameTenant = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<?>>();
            fixture.transactions.executeWithoutResult(ignored -> {
                journal.authorizeOrdinary("tenant", fixture.session, token, originalRequest);
                sameTenant.set(pool.submit(() -> {
                    entered.countDown();
                    fixture.transactions.executeWithoutResult(transaction ->
                            journal.authorizeOrdinary("tenant", "neighbor-session", token, neighborRequest));
                }));
                var differentTenant = pool.submit(() -> {
                    entered.countDown();
                    fixture.transactions.executeWithoutResult(transaction ->
                            journal.authorizeOrdinary(otherTenant, otherSession, token, otherRequest));
                });
                try {
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    // Ordinary admissions fence per Session (drain + head) and
                    // never queue on tenant-wide rows: neither the sibling
                    // session of the same tenant nor another tenant's session
                    // waits on the in-flight authorisation above (#13800).
                    sameTenant.get().get(5, TimeUnit.SECONDS);
                    differentTenant.get(5, TimeUnit.SECONDS);
                    // The fence that stays is per Session: a second ordinary
                    // authorisation of this same Session queues behind the
                    // open one until it commits.
                    sameSession.set(pool.submit(() -> fixture.transactions.executeWithoutResult(transaction ->
                            journal.authorizeOrdinary("tenant", fixture.session, token, originalRequest))));
                    MySqlLockProbe.awaitLockWaits(fixture.jdbc, schema, 1, "the same-Session authorisation");
                    assertThat(sameSession.get()).isNotDone();
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            });
            sameSession.get().get(10, TimeUnit.SECONDS);
        }
    }

    @Test
    void aFailureAfterRetirementRollsBackTheEntireDeleteAndRetryReusesEffects() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        var effects = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        fixture.jdbc.execute("CREATE TRIGGER l3_delete_failure BEFORE UPDATE ON ma_session FOR EACH ROW"
                + " BEGIN IF NEW.status = 'DELETED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'l3 injected crash'; END IF; END");
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).hasMessageContaining("l3 injected crash");
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("DELETING");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retirement_operation_id IS NOT NULL", Integer.class)).isZero();
        assertThat(fixture.store.findOperation("tenant", fixture.session, operation.operationId()).orElseThrow().receiptId()).isNull();
        fixture.jdbc.execute("DROP TRIGGER l3_delete_failure");
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(operation)))
                .isEqualTo(effects);
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retirement_operation_id IS NOT NULL", Integer.class)).isOne();
    }

    /**
     * The lifecycle admission's composition (#13800 R2-3): its plain reads
     * pin the REPEATABLE READ snapshot before the head lock is granted, and
     * a writer commits a revision in between. The idle check must decide on
     * that revision (here a still-pending Turn, so turn_active), never
     * refuse an admission it could have read as workspace_lifecycle_journal_unverified,
     * and never admit over it. Removing the locking rescan turns the direct
     * arm into journal_unverified; removing the head re-verification turns
     * it into a silent admission.
     */
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void idleJournalCheckReadsARevisionItsSnapshotCannotSee(boolean throughAdmission) throws Exception {
        var fixture = fixture();
        var store = new ManagedSessionStore(fixture.jdbc);
        var journal = fixture.transactions.execute(ignored ->
                new ExtensionRecordJournal(store, "tenant", "workspace", fixture.session).open());
        var txManager = new DataSourceTransactionManager(source);
        // Declared rather than inherited: under a server defaulted to READ
        // COMMITTED every statement gets a fresh read view and the snapshot
        // below would see the late revision anyway.
        var definition = new DefaultTransactionDefinition();
        definition.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        var snapshot = txManager.getTransaction(definition);
        try {
            // Pin this REPEATABLE READ transaction's read view with a plain
            // consistent read, as the admission's replay and open-operation
            // reads do, before the writer appends behind the head's lock.
            fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head"
                    + " WHERE tenant_id = ? AND session_id = ?", Long.class, "tenant", fixture.session);
            commitPendingTurn(fixture, journal);
            // The head's revision is ahead of this transaction's read view.
            assertThatThrownBy(() -> {
                if (throughAdmission) {
                    fixture.store.beginWorkspaceLifecycle("tenant", fixture.session, OperationKind.DELETE, "owner",
                            "a".repeat(64), "operation", "digest", true, 1);
                } else {
                    WorkspaceLifecycleStore.requireIdleJournal(fixture.jdbc, fixture.json,
                            "tenant", fixture.session);
                }
            }).isInstanceOfSatisfying(ApiException.class, error ->
                    assertThat(error.getCode()).isEqualTo("turn_active"));
        } finally {
            txManager.rollback(snapshot);
        }
    }

    /** A journal that falls short of its own head even when read as committed now fails closed. */
    @Test
    void idleJournalCheckFailsClosedOnAJournalShortOfItsHead() throws Exception {
        var fixture = fixture();
        var store = new ManagedSessionStore(fixture.jdbc);
        var journal = fixture.transactions.execute(ignored ->
                new ExtensionRecordJournal(store, "tenant", "workspace", fixture.session).open());
        commitPendingTurn(fixture, journal);
        fixture.jdbc.update("UPDATE ma_session_head SET journal_revision = journal_revision + 1"
                + " WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                "tenant", fixture.session);
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored ->
                WorkspaceLifecycleStore.requireIdleJournal(fixture.jdbc, fixture.json, "tenant", fixture.session)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("workspace_lifecycle_journal_unverified"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"accepted-settled", "other-settled", "accepted-pending"})
    void unadmittedCancellationUsesTheFencedJournalSnapshot(String cut) throws Exception {
        var fixture = fixture();
        var store = new ManagedSessionStore(fixture.jdbc);
        fixture.transactions.executeWithoutResult(ignored ->
                new ExtensionRecordJournal(store, "tenant", "workspace", fixture.session).open());
        String turn = fixture.transactions.execute(ignored -> fixture.store.insertTurnCommand("tenant", "SUBMIT_TURN",
                "ambiguous-prompt", "digest", fixture.session, List.of(), "payload", "owner").turnId());
        fixture.transactions.execute(ignored -> fixture.store.claimTurn("tenant", fixture.session, turn,
                "dispatch-owner", Duration.ofMinutes(1)));
        fixture.transactions.executeWithoutResult(ignored -> fixture.store.markSubmissionAttempted("tenant", fixture.session,
                turn, "dispatch-owner"));
        fixture.transactions.execute(ignored -> fixture.store.insertCancelCommand("tenant", "CANCEL_TURN",
                "cancel-ambiguous", "digest", fixture.session, turn, "owner"));
        String prompt = "other-settled".equals(cut) ? "other-prompt"
                : fixture.store.findTurn("tenant", fixture.session, turn).orElseThrow().promptId();
        var request = fixture.promptCommit(prompt, !"accepted-pending".equals(cut));
        var manager = new DataSourceTransactionManager(source);
        var definition = new DefaultTransactionDefinition();
        definition.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        var snapshot = manager.getTransaction(definition);
        boolean cancelled;
        try {
            // Match the plain Turn read that pins the cancellation transaction before its head fence.
            fixture.store.findTurn("tenant", fixture.session, turn).orElseThrow();
            try (var writer = Executors.newSingleThreadExecutor()) {
                writer.submit(() -> fixture.transactions.executeWithoutResult(ignored -> {
                    store.commit("tenant", fixture.session, "extension-writer-token-0123456789", request);
                    store.sealWriter("tenant", fixture.session, "extension-writer-token-0123456789",
                            new ManagedSessionStoreModels.SealWriterRequest("workspace", "writer-extension", 1));
                })).get(30, TimeUnit.SECONDS);
            }
            assertThat(fixture.jdbc.queryForObject("SELECT MAX(journal_revision) FROM ma_session_journal_tx"
                    + " WHERE tenant_id = ? AND session_id = ?", Long.class, "tenant", fixture.session)).isEqualTo(1L);
            cancelled = fixture.store.cancelUnadmittedTurn("tenant", fixture.session, turn, "dispatch-owner");
            manager.commit(snapshot);
        } catch (Exception | AssertionError failure) {
            if (!snapshot.isCompleted()) {
                manager.rollback(snapshot);
            }
            throw failure;
        }
        boolean expected = "other-settled".equals(cut);
        var result = fixture.store.findTurn("tenant", fixture.session, turn).orElseThrow();
        assertAll(cut,
                () -> assertThat(cancelled).as("cancellation decision").isEqualTo(expected),
                () -> assertThat(result.status()).isEqualTo(expected ? "CANCELLED" : "CANCELLING"),
                () -> assertThat(result.submissionAttempted()).as("submission attempted").isEqualTo(!expected),
                () -> assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE event_type = 'turn.cancelled'",
                        Integer.class)).as("durable cancellation events").isEqualTo(expected ? 1 : 0));
    }

    /** Commits, from another thread and transaction, a revision that leaves a Turn's input pending. */
    private static void commitPendingTurn(Fixture fixture, ExtensionRecordJournal journal) throws Exception {
        var templates = ManagedHookRecordContractTest.fixtures().get("templates");
        var data = new ManagedSessionStoreModels.CommitResource("hook-data", "hook-data", 1, 2, sha256("{}"), "e30=");
        ObjectNode registration = templates.get("hook_registration").deepCopy();
        registration.withObject("/catalogRef").put("digest", data.digest());
        var input = new ManagedSessionStoreModels.CommitResource("witness-input", "managed-input", 1, 2,
                sha256("{}"), "e30=");
        var request = journal.requestDomainWithInput("witness-input", "hook_registration", registration,
                List.of(data), "witness-turn", input);
        try (var writer = Executors.newSingleThreadExecutor()) {
            writer.submit(() -> fixture.transactions.executeWithoutResult(ignored -> journal.commit(request)))
                    .get(30, TimeUnit.SECONDS);
        }
    }

    private static String sha256(String value) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
