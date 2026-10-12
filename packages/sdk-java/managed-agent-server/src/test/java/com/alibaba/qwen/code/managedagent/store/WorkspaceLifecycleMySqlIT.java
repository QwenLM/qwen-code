package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

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
        fixture.jdbc.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id, workspace_id,"
                + " session_id, domain, record_id, operation_hash, revision, record_resource_id, created_at, first_sequence)"
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
                    if (!release.await(10, TimeUnit.SECONDS)) throw new AssertionError("Lifecycle hold was not released");
                    return null;
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            }));
            try {
                assertThat(entered.await(10, TimeUnit.SECONDS)).isTrue();
                var neighbor = workers.submit(() -> new JdbcTemplate(source).update(
                        "UPDATE qwen_managed_session_extension_record SET revision = revision + 1 WHERE session_scope_key = ? AND record_key = ?",
                        scope, record));
                assertThat(neighbor.get(2, TimeUnit.SECONDS)).isEqualTo(1);
            } finally {
                release.countDown();
            }
            held.get(10, TimeUnit.SECONDS);
        }
        assertThat(fixture.jdbc.queryForObject("SELECT revision FROM qwen_managed_session_extension_record"
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
            fixture.jdbc.update("UPDATE managed_agent_operation SET lease_until = UNIX_TIMESTAMP() * 1000 - 1000 WHERE operation_id = ?", id);
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
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
    }

    @Test
    void ordinaryAuthorizationKeepsFenceLocksInsideTheTenant() throws Exception {
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
        try (var pool = Executors.newFixedThreadPool(2)) {
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
                    assertThrows(TimeoutException.class, () -> sameTenant.get().get(100, TimeUnit.MILLISECONDS));
                    differentTenant.get(5, TimeUnit.SECONDS);
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
            });
            sameTenant.get().get(5, TimeUnit.SECONDS);
        }
    }

    @Test
    void aFailureAfterRetirementRollsBackTheEntireDeleteAndRetryReusesEffects() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        var effects = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        fixture.jdbc.execute("CREATE TRIGGER l3_delete_failure BEFORE UPDATE ON managed_agent_session FOR EACH ROW"
                + " BEGIN IF NEW.status = 'DELETED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'l3 injected crash'; END IF; END");
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).hasMessageContaining("l3 injected crash");
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("DELETING");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isZero();
        assertThat(fixture.store.findOperation("tenant", fixture.session, operation.operationId()).orElseThrow().receiptId()).isNull();
        fixture.jdbc.execute("DROP TRIGGER l3_delete_failure");
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(operation)))
                .isEqualTo(effects);
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isOne();
    }
}
