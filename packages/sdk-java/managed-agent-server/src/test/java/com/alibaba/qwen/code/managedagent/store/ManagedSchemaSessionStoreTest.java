package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.*;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class ManagedSchemaSessionStoreTest {
    protected JdbcTemplate jdbc;
    protected TransactionTemplate tx;
    protected ManagedAgentStore store;
    private final MutableClock clock = new MutableClock();
    private String tenant;
    private String session;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:session32-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        return source;
    }

    @BeforeEach
    void setup() {
        var source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        tx = new TransactionTemplate(new DataSourceTransactionManager(source));
        store =
                new ManagedAgentStore(
                        jdbc,
                        new ObjectMapper(),
                        clock,
                        ignored -> {},
                        new ManagedWorkspaceRegistry(jdbc),
                        new ManagedAgentProperties());
        tenant = "tenant-" + UUID.randomUUID();
        session =
                tx.execute(
                                status ->
                                        store.insertSessionCommand(
                                                tenant,
                                                "actor",
                                                "CREATE_SESSION",
                                                "create-key",
                                                "create-digest",
                                                "qwen-code",
                                                null,
                                                "title",
                                                List.of(),
                                                null))
                        .sessionId();
    }

    @Test
    void publicAndPrivateSessionScopesRemainDistinctAndByteExact() {
        assertThat(store.findSession(tenant, session)).isPresent();
        assertThat(store.findSession(tenant.toUpperCase(), session)).isEmpty();
        assertThat(store.findSession(tenant + " ", session)).isEmpty();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_request_receipt WHERE tenant_id = ?",
                                Integer.class,
                                tenant))
                .isEqualTo(2);
        for (String scope : List.of(tenant, tenant + "other")) {
            jdbc.update(
                    "INSERT INTO ma_session (tenant_id, session_id, session_kind, gmt_create,"
                            + " gmt_modified) VALUES (?, ?, 'CONTROL', 1, 1)",
                    scope,
                    "same-private");
        }
        assertThat(store.findSessionById("same-private")).isEmpty();
        assertThat(store.listSessions(tenant, "actor", null, null, 10).sessions()).hasSize(1);
        assertThatThrownBy(
                        () ->
                                tx.execute(
                                        status ->
                                                store.insertCancelCommand(
                                                        tenant,
                                                        "CANCEL",
                                                        "cancel",
                                                        "digest",
                                                        "same-private",
                                                        "turn")))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void immutablePaginationSurvivesNewMessagesAndExpires() {
        for (int i = 0; i < 4; i++) {
            event("item-" + i, "text-" + i);
        }
        materialize();
        var first = store.findSnapshotPage(tenant, session, null, 0, 2);
        assertThat(first.items()).hasSize(2);
        assertThat(first.hasMore()).isTrue();
        event("item-2", "changed");
        event("item-4", "new");
        clock.advance(Duration.ofSeconds(6));
        materialize();
        var next = store.findSnapshotPage(tenant, session, first.nextCursor(), 0, 2);
        assertThat(next.items())
                .extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("item-2", "item-3");
        assertThat(next.items().getFirst().content().getFirst().text()).isEqualTo("text-2");
        assertThat(next.coveredSequence()).isEqualTo(first.coveredSequence());
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_snapshot WHERE tenant_id = ?",
                                Integer.class,
                                tenant))
                .isEqualTo(2);
        assertThat(store.findSnapshotPage(tenant, session, null, 0, 10).items()).hasSize(5);
        clock.advance(Duration.ofMinutes(31));
        assertThatThrownBy(() -> store.findSnapshotPage(tenant, session, first.nextCursor(), 0, 2))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("expired");
    }

    @Test
    void oversizedPartsAreResourceBackedAndRemainReadable() {
        long derived = clock.millis();
        event("big", "a".repeat(70_000));
        materialize();
        // Writing the resource-backed body must not re-stamp the item: its modification
        // time belongs to the derived event timeline, so re-materializing an old session
        // cannot make every item look freshly changed.
        assertThat(
                        jdbc.queryForObject(
                                "SELECT gmt_modified FROM ma_message WHERE tenant_id = ?",
                                Long.class,
                                tenant))
                .isEqualTo(derived);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT body_resource_key FROM ma_message WHERE tenant_id = ?",
                                String.class,
                                tenant))
                .hasSize(64);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT parts_json FROM ma_message WHERE tenant_id = ?",
                                String.class,
                                tenant))
                .isEqualTo("[]");
        assertThat(
                        store.findSnapshot(tenant, session)
                                .orElseThrow()
                                .items()
                                .getFirst()
                                .content()
                                .getFirst()
                                .text())
                .hasSize(70_000);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'MESSAGE'"
                                        + " AND session_scope_key = ?",
                                Integer.class,
                                ManagedSessionStore.sessionScopeKey(tenant, session)))
                .isEqualTo(1);
    }

    @Test
    void expiredSnapshotBodiesAreCollectedWithoutRetiringAnIdleSession() {
        alignProjectionClock();
        for (int i = 0; i < 4; i++) {
            event("item-" + i, "text-" + i);
            materialize();
            clock.advance(Duration.ofSeconds(6));
        }
        jdbc.update("UPDATE ma_snapshot SET retain_until = 0 WHERE tenant_id = ?", tenant);
        var properties = new ManagedAgentProperties();
        var collector = new SessionResourceCollectionCollector(jdbc,
                new DataSourceTransactionManager(java.util.Objects.requireNonNull(jdbc.getDataSource())), properties);
        assertThat(collector.runOnce()).isFalse();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_snapshot WHERE tenant_id = ?", Integer.class, tenant))
                .isEqualTo(4);
        properties.getToolPublication().setGcEnabled(true);
        assertThat(collector.runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_snapshot WHERE tenant_id = ?", Integer.class, tenant))
                .isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE tenant_id = ? AND state = 'COLLECTED'"
                + " AND inline_bytes IS NULL", Integer.class, tenant)).isEqualTo(6);
        assertThat(store.findSnapshot(tenant, session).orElseThrow().items()).hasSize(4);
        assertThat(jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session)).isNull();
    }

    @Test
    void validCursorRetainsOldLargeBodyUntilItsSnapshotExpires() {
        alignProjectionClock();
        event("small", "first");
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        var cursor = store.findSnapshotPage(tenant, session, null, 0, 1).nextCursor();
        event("big", "b".repeat(70_000));
        clock.advance(Duration.ofSeconds(6));
        materialize();
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        assertThat(store.findSnapshotPage(tenant, session, cursor, 0, 1).items().getFirst().content().getFirst().text())
                .isEqualTo("a".repeat(70_000));
        clock.advance(Duration.ofMinutes(31));
        jdbc.update("UPDATE ma_snapshot SET retain_until = 0 WHERE tenant_id = ?", tenant);
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("COLLECTED");
        assertThat(resourceState(messageBody("big"))).isEqualTo("REFERENCED");
        assertThat(store.findSnapshot(tenant, session).orElseThrow().items().getLast().content().getFirst().text())
                .isEqualTo("a".repeat(70_000) + "b".repeat(70_000));
    }

    @Test
    void activeReadLeasePinsReleasedBodiesUntilItCloses() {
        alignProjectionClock();
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        event("big", "b");
        clock.advance(Duration.ofSeconds(6));
        materialize();
        var retention = new ToolPublicationRetentionStore(jdbc,
                new DataSourceTransactionManager(java.util.Objects.requireNonNull(jdbc.getDataSource())));
        try (var lease = retention.read(tenant, session)) {
            jdbc.update("UPDATE ma_snapshot SET retain_until = 0 WHERE tenant_id = ?", tenant);
            projectionCollector().runOnce();
            lease.check();
            assertThat(resourceState(original)).isEqualTo("REFERENCED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?",
                    Integer.class, original)).isZero();
        }
        makeProjectionCandidatesDue();
        assertThat(projectionCollector().runOnce()).isTrue();
        assertThat(resourceState(original)).isEqualTo("COLLECTED");
    }

    @Test
    void pausedRepeatableReadSnapshotBuildProtectsAReleasedMessageBody() throws Exception {
        try (var connection = jdbc.getDataSource().getConnection()) {
            org.junit.jupiter.api.Assumptions.assumeTrue(
                    "MySQL".equals(connection.getMetaData().getDatabaseProductName()),
                    "Cross-table consistent read is a real MySQL acceptance gate");
        }
        alignProjectionClock();
        event("big", "a".repeat(70_000));
        materialize();
        String body = messageBody("big");
        var original = store.findSnapshot(tenant, session).orElseThrow();
        jdbc.update("UPDATE ma_snapshot SET retain_until = 0 WHERE tenant_id = ?", tenant);
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var builder = new ManagedSnapshotStore(jdbc, new ObjectMapper(), clock, (t, id, guard) -> {
            entered.countDown();
            try {
                if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                    throw new IllegalStateException("projection did not commit");
                }
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            guard.run();
            assertThat(jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id = ? AND session_id = ?",
                    String.class, tenant, session)).isEqualTo(body);
            assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?", byte[].class, body))
                    .isNotEmpty();
            return original.items();
        });
        try (var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var build = executor.submit(() -> builder.build(tenant, session));
            try {
                assertThat(entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                event("big", "b");
                clock.advance(Duration.ofSeconds(6));
                materialize();
                projectionCollector().runOnce();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?", Integer.class, body))
                        .isZero();
                assertThat(resourceState(body)).isEqualTo("REFERENCED");
            } finally {
                release.countDown();
            }
            build.get(10, java.util.concurrent.TimeUnit.SECONDS);
        }
        makeProjectionCandidatesDue();
        projectionCollector().runOnce();
        assertThat(resourceState(body)).isEqualTo("COLLECTED");
    }

    @Test
    void projectionCleanupPreservesJournalReferencesAndRecoveryProtection() {
        alignProjectionClock();
        var privateBody = tx.execute(status -> new ManagedSessionStore(jdbc)
                .publishAgentInstructions(tenant, "workspace", session, "private instructions"));
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                scope, scope, original, tenant, session);
        event("big", "b");
        clock.advance(Duration.ofSeconds(6));
        materialize();
        jdbc.update("UPDATE ma_snapshot SET retain_until = 0 WHERE tenant_id = ?", tenant);
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        tx.executeWithoutResult(status -> {
            ManagedProjectionResourceCollector.release(jdbc, scope, "JOURNAL", scope);
            jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'JOURNAL' AND owner_key = ?", scope);
            jdbc.update("UPDATE ma_session SET recovery_protected = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
        });
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        jdbc.update("UPDATE ma_session SET recovery_protected = FALSE WHERE tenant_id = ? AND session_id = ?", tenant, session);
        makeProjectionCandidatesDue();
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("COLLECTED");
        assertThat(resourceState(ManagedSessionStore.resourceKey(scope, privateBody.resourceId()))).isEqualTo("PUBLISHED");
    }

    private void alignProjectionClock() {
        clock.instant = Instant.ofEpochMilli(ToolPublicationRetentionStore.now(jdbc));
    }

    private ManagedProjectionResourceCollector projectionCollector() {
        return new ManagedProjectionResourceCollector(jdbc,
                new DataSourceTransactionManager(java.util.Objects.requireNonNull(jdbc.getDataSource())));
    }

    private String messageBody(String item) {
        return jdbc.queryForObject("SELECT body_resource_key FROM ma_message WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                String.class, tenant, session, item);
    }

    private String resourceState(String resource) {
        return jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?", String.class, resource);
    }

    private void makeProjectionCandidatesDue() {
        jdbc.update("UPDATE ma_resource SET retention_until = 946684800000 WHERE tenant_id = ? AND retention_until IS NOT NULL", tenant);
    }

    @Test
    void renameRevisionAndClaimGenerationFenceStaleWorkers() {
        var command =
                tx.execute(
                        status ->
                                store.beginSessionRename(tenant, "r1", "digest", session, "first"));
        var candidate = store.deliverableRenames(clock.millis()).getFirst();
        var old =
                tx.execute(
                                status ->
                                        store.claimRename(
                                                candidate, "same-owner", Duration.ofSeconds(1)))
                        .orElseThrow();
        jdbc.update(
                "UPDATE ma_operation SET claim_until = 946684800000 WHERE"
                        + " operation_kind = 'RENAME' AND tenant_id = ?",
                tenant);
        var current =
                tx.execute(
                                status ->
                                        store.claimRename(
                                                candidate, "same-owner", Duration.ofSeconds(1)))
                        .orElseThrow();
        store.retryRename(old, "same-owner", 0);
        assertThatThrownBy(
                        () ->
                                tx.execute(
                                        status ->
                                                store.completeSessionRename(
                                                        old, "same-owner", "boot")))
                .hasMessageContaining("claim was lost");
        tx.execute(status -> store.completeSessionRename(current, "same-owner", "boot"));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("first");
        var later =
                tx.execute(
                        status ->
                                store.beginSessionRename(
                                        tenant, "r2", "digest2", session, "second"));
        assertThat(later.renameRevision()).isGreaterThan(command.renameRevision());
        assertThatThrownBy(
                        () ->
                                tx.execute(
                                        status ->
                                                store.completeSessionRename(
                                                        tenant,
                                                        "r1",
                                                        session,
                                                        "first",
                                                        "boot",
                                                        command.renameRevision())))
                .hasMessageContaining("later Session title");
    }

    @Test
    void modifiedCursorCannotExtendItsValidityOrChangeItsPosition() throws Exception {
        event("a", "first");
        event("b", "second");
        materialize();
        String cursor = store.findSnapshotPage(tenant, session, null, 0, 1).nextCursor();
        String[] parts = cursor.split("\\.");
        var mapper = new ObjectMapper();
        var data =
                (com.fasterxml.jackson.databind.node.ObjectNode)
                        mapper.readTree(Base64.getUrlDecoder().decode(parts[0]));
        data.put("expires", clock.millis() + Duration.ofDays(365).toMillis());
        String changed =
                Base64.getUrlEncoder()
                                .withoutPadding()
                                .encodeToString(mapper.writeValueAsBytes(data))
                        + "."
                        + parts[1];
        assertThatThrownBy(() -> store.findSnapshotPage(tenant, session, changed, 0, 1))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("cursor");
        assertThat(store.findSnapshotPage(tenant, session, cursor, 0, 1).items())
                .extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("b");
    }

    @Test
    void messageProjectionRefusesAValidDigestBodyWithAnotherSessionScope() {
        event("big", "a".repeat(70_000));
        materialize();
        jdbc.update(
                "UPDATE ma_resource SET session_scope_key = ? WHERE resource_key = (SELECT"
                    + " body_resource_key FROM ma_message WHERE tenant_id = ? AND item_id = ?)",
                ManagedSessionStore.sessionScopeKey(tenant, "another-session"),
                tenant,
                "big");
        assertThatThrownBy(() -> store.findSnapshot(tenant, session))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Snapshot resource is unavailable");
        event("big", "next");
        assertThatThrownBy(this::materialize)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Message body resource is unavailable");
    }

    @Test
    void oldSnapshotPinsLargeMessageBodyAfterLatestMessageChanges() {
        event("big", "a".repeat(70_000));
        event("last", "last");
        materialize();
        var first = store.findSnapshotPage(tenant, session, null, 0, 1);
        String body =
                jdbc.queryForObject(
                        "SELECT body_resource_key FROM ma_message WHERE tenant_id = ? AND item_id ="
                                + " ?",
                        String.class,
                        tenant,
                        "big");
        event("big", "b");
        clock.advance(Duration.ofSeconds(6));
        materialize();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'MESSAGE'"
                                        + " AND resource_key = ?",
                                Integer.class,
                                body))
                .isZero();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'SNAPSHOT'"
                                        + " AND resource_key = ?",
                                Integer.class,
                                body))
                .isEqualTo(1);
        assertThat(store.findSnapshotPage(tenant, session, first.nextCursor(), 0, 1).items())
                .extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("last");
        assertThat(
                        store
                                .findSnapshot(tenant, session)
                                .orElseThrow()
                                .items()
                                .getFirst()
                                .content()
                                .stream()
                                .map(StoreModels.ItemPartRecord::text)
                                .collect(java.util.stream.Collectors.joining())
                                .length())
                .isEqualTo(70_001);
    }

    @Test
    void consistentViewPairsWatermarkAndMessagesWhileAnotherTransactionCommits() throws Exception {
        try (var connection = jdbc.getDataSource().getConnection()) {
            org.junit.jupiter.api.Assumptions.assumeTrue(
                    connection.getMetaData().getDatabaseProductName().equals("MySQL"),
                    "Cross-table consistent read is a real MySQL acceptance gate");
        }
        event("a", "before");
        materialize();
        var original = store.findSnapshot(tenant, session).orElseThrow();
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var snapshot =
                new ManagedSnapshotStore(
                        jdbc,
                        new ObjectMapper(),
                        clock,
                        (t, id, guard) -> {
                            entered.countDown();
                            try {
                                if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                                    throw new IllegalStateException("writer did not commit");
                                }
                            } catch (InterruptedException interrupted) {
                                Thread.currentThread().interrupt();
                                throw new IllegalStateException(interrupted);
                            }
                            guard.run();
                            assertThat(
                                            jdbc.queryForObject(
                                                    "SELECT covered_sequence FROM ma_event_stream"
                                                        + " WHERE tenant_id = ? AND session_id = ?"
                                                        + " AND stream_kind = 'SESSION'",
                                                    Long.class,
                                                    t,
                                                    id))
                                    .isEqualTo(original.coveredSequence());
                            assertThat(
                                            jdbc.queryForObject(
                                                    "SELECT parts_json FROM ma_message WHERE"
                                                        + " tenant_id = ? AND session_id = ? AND"
                                                        + " item_id = ?",
                                                    String.class,
                                                    t,
                                                    id,
                                                    "a"))
                                    .contains("before")
                                    .doesNotContain("after");
                            return original.items();
                        });
        try (var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var build = executor.submit(() -> snapshot.build(tenant, session));
            try {
                assertThat(entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                event("a", "after");
                materialize();
                assertThat(
                                jdbc.queryForObject(
                                        "SELECT parts_json FROM ma_message WHERE tenant_id = ? AND"
                                                + " session_id = ? AND item_id = ?",
                                        String.class,
                                        tenant,
                                        session,
                                        "a"))
                        .contains("beforeafter");
            } finally {
                release.countDown();
            }
            build.get(10, java.util.concurrent.TimeUnit.SECONDS);
        }
    }

    @Test
    void writerHeartbeatCompletesWhileSnapshotBodyConstructionIsPaused() throws Exception {
        var privateStore = new ManagedSessionStore(jdbc);
        String token = "a".repeat(32);
        var grant =
                tx.execute(
                        status ->
                                privateStore.acquireWriter(
                                        tenant,
                                        session,
                                        token,
                                        new ManagedSessionStoreModels.AcquireWriterRequest(
                                                "workspace", "writer", 60_000L)));
        event("a", "before");
        materialize();
        var original = store.findSnapshot(tenant, session).orElseThrow();
        var entered = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        var snapshot =
                new ManagedSnapshotStore(
                        jdbc,
                        new ObjectMapper(),
                        clock,
                        (t, id, guard) -> {
                            entered.countDown();
                            try {
                                if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                                    throw new IllegalStateException("heartbeat did not complete");
                                }
                            } catch (InterruptedException interrupted) {
                                Thread.currentThread().interrupt();
                                throw new IllegalStateException(interrupted);
                            }
                            guard.run();
                            return original.items();
                        });
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var build = executor.submit(() -> snapshot.build(tenant, session));
            try {
                assertThat(entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var heartbeat =
                        executor.submit(
                                () ->
                                        tx.execute(
                                                status ->
                                                        privateStore.renewWriter(
                                                                tenant,
                                                                session,
                                                                token,
                                                                new ManagedSessionStoreModels
                                                                        .RenewWriterRequest(
                                                                        "workspace",
                                                                        "writer",
                                                                        grant.writerGeneration(),
                                                                        60_000L))));
                assertThat(
                                heartbeat
                                        .get(3, java.util.concurrent.TimeUnit.SECONDS)
                                        .writerGeneration())
                        .isEqualTo(grant.writerGeneration());
            } finally {
                release.countDown();
            }
            build.get(10, java.util.concurrent.TimeUnit.SECONDS);
        }
    }

    @Test
    void harnessOnlyHeadHasNoPrivateJournalReadAuthority() {
        String token = "a".repeat(32);
        jdbc.update(
                "INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(
                        tenant),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.harnessDrainKey(
                        session),
                tenant,
                session,
                session);
        var privateStore = new ManagedSessionStore(jdbc);
        assertThatThrownBy(() -> privateStore.restore(tenant, "workspace", session, token))
                .isInstanceOfSatisfying(
                        ApiException.class,
                        error ->
                                assertThat(error.getCode()).isEqualTo("managed_session_not_found"));
        var grant =
                tx.execute(
                        status ->
                                privateStore.acquireWriter(
                                        tenant,
                                        session,
                                        token,
                                        new ManagedSessionStoreModels.AcquireWriterRequest(
                                                "workspace", "writer", 60_000L)));
        assertThat(grant.writerGeneration()).isEqualTo(1);
        assertThat(privateStore.restore(tenant, "workspace", session, token).journalRevision())
                .isZero();
    }

    @Test
    void withdrawnMessageDisappearsAndReissuedBodyHasItsNewSequence() {
        String turn =
                tx.execute(
                                status ->
                                        store.insertTurnCommand(
                                                tenant,
                                                "SUBMIT_TURN",
                                                "retract-turn",
                                                "digest",
                                                session,
                                                List.of(),
                                                "payload"))
                        .turnId();
        tx.execute(
                status -> store.claimTurn(tenant, session, turn, "owner", Duration.ofMinutes(1)));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "item.output_text.delta",
                                Map.of("itemId", "withdrawn", "text", "x".repeat(70_000)),
                                false,
                                "boot:old:1"));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "item.output_text.delta",
                                Map.of("itemId", "kept", "text", "kept"),
                                false,
                                "boot:kept:1"));
        materialize();
        var frozen = store.findSnapshotPage(tenant, session, null, 0, 1);
        String oldBody =
                jdbc.queryForObject(
                        "SELECT body_resource_key FROM ma_message WHERE"
                                + " tenant_id = ? AND session_id = ? AND item_id = ?",
                        String.class,
                        tenant,
                        session,
                        "withdrawn");
        long first =
                store.findSnapshot(tenant, session).orElseThrow().items().stream()
                        .filter(item -> "withdrawn".equals(item.itemId()))
                        .findFirst()
                        .orElseThrow()
                        .firstSequence();
        long tail = store.requireSession(tenant, session).lastSequence();
        long floor = store.findReplayWindow(tenant, session).floorSequence();
        tx.executeWithoutResult(
                status ->
                        store.retractContinuationOutput(
                                tenant, session, turn, "owner", "boot", "old"));
        assertThat(store.findSnapshot(tenant, session).orElseThrow().items())
                .extracting(StoreModels.ItemRecord::itemId)
                .doesNotContain("withdrawn");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?"
                                        + " AND owner_kind = 'MESSAGE'",
                                Integer.class,
                                oldBody))
                .isZero();
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?"
                                        + " AND owner_kind = 'SNAPSHOT'",
                                Integer.class,
                                oldBody))
                .isPositive();
        assertThat(store.findSnapshotPage(tenant, session, frozen.nextCursor(), 0, 10).items())
                .filteredOn(item -> "withdrawn".equals(item.itemId()))
                .singleElement()
                .satisfies(item -> assertThat(item.content().getFirst().text()).hasSize(70_000));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "item.output_text.delta",
                                Map.of("itemId", "withdrawn", "text", "new"),
                                false,
                                "boot:new:1"));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "turn.completed",
                                Map.of(),
                                true,
                                "boot:new:2"));
        materialize();
        assertThat(store.findSnapshotPage(tenant, session, null, first, 10).items())
                .filteredOn(item -> "withdrawn".equals(item.itemId()))
                .singleElement()
                .satisfies(
                        item -> {
                            assertThat(item.firstSequence()).isGreaterThan(first);
                            assertThat(item.status()).isEqualTo("completed");
                            assertThat(item.content().getFirst().text()).isEqualTo("new");
                        });
        assertThat(store.requireSession(tenant, session).lastSequence()).isEqualTo(tail + 3);
        assertThat(store.findReplayWindow(tenant, session).floorSequence()).isEqualTo(floor);
    }

    @Test
    void partialRetractionRebuildsSurvivingMessageBoundsAndTerminalState() {
        String turn =
                tx.execute(
                                status ->
                                        store.insertTurnCommand(
                                                tenant,
                                                "SUBMIT_TURN",
                                                "partial-turn",
                                                "digest",
                                                session,
                                                List.of(),
                                                "payload"))
                        .turnId();
        tx.execute(
                status -> store.claimTurn(tenant, session, turn, "owner", Duration.ofMinutes(1)));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "item.output_text.delta",
                                Map.of("itemId", "same", "text", "old"),
                                false,
                                "boot:old:1"));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "item.output_text.delta",
                                Map.of("itemId", "same", "text", "kept"),
                                false,
                                "boot:kept:1"));
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                turn,
                                "turn.failed",
                                Map.of(),
                                true,
                                "boot:kept:2"));
        materialize();
        var before =
                store.findSnapshot(tenant, session).orElseThrow().items().stream()
                        .filter(item -> "same".equals(item.itemId()))
                        .findFirst()
                        .orElseThrow();
        tx.executeWithoutResult(
                status ->
                        store.retractContinuationOutput(
                                tenant, session, turn, "owner", "boot", "old"));
        assertThat(store.findSnapshot(tenant, session).orElseThrow().items())
                .filteredOn(item -> "same".equals(item.itemId()))
                .singleElement()
                .satisfies(
                        item -> {
                            assertThat(item.firstSequence()).isEqualTo(before.firstSequence() + 1);
                            assertThat(item.lastSequence()).isEqualTo(before.lastSequence());
                            assertThat(item.status()).isEqualTo("failed");
                            assertThat(item.revision()).isGreaterThan(before.revision());
                            assertThat(item.content())
                                    .singleElement()
                                    .satisfies(part -> assertThat(part.text()).isEqualTo("kept"));
                        });
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"none", "scope", "bytes", "deletion"})
    void duplicateMessageBodyIdentityIsReusedOnlyWhenItsImmutableRowMatches(String corruption) {
        var duplicate = new DuplicateBodyJdbc(jdbc.getDataSource(), corruption);
        var subject =
                new ManagedAgentStore(
                        duplicate,
                        new ObjectMapper(),
                        clock,
                        ignored -> {},
                        new ManagedWorkspaceRegistry(duplicate),
                        new ManagedAgentProperties());
        event("big", "x".repeat(70_000));
        if ("none".equals(corruption)) {
            tx.executeWithoutResult(status -> subject.materializeNextBatch(tenant, session, 100));
            assertThat(subject.findSnapshot(tenant, session).orElseThrow().items())
                    .singleElement()
                    .satisfies(
                            item -> assertThat(item.content().getFirst().text()).hasSize(70_000));
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM ma_resource WHERE tenant_id = ?"
                                            + " AND kind = ?",
                                    Integer.class,
                                    tenant,
                                    "managed-message-parts"))
                    .isEqualTo(1);
        } else {
            assertThatThrownBy(
                            () ->
                                    tx.executeWithoutResult(
                                            status ->
                                                    subject.materializeNextBatch(
                                                            tenant, session, 100)))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("Immutable message body identity differs");
            assertThat(
                            jdbc.queryForObject(
                                    "SELECT COUNT(*) FROM ma_message WHERE tenant_id = ?",
                                    Integer.class,
                                    tenant))
                    .isZero();
        }
        assertThat(duplicate.injected).isTrue();
    }

    private static final class DuplicateBodyJdbc extends ManagedSchemaJdbcTemplate {
        private final String corruption;
        private boolean injected;

        DuplicateBodyJdbc(DataSource source, String corruption) {
            super(source);
            this.corruption = corruption;
        }

        @Override
        public int update(String sql, Object... arguments) {
            int changed = super.update(sql, arguments);
            if (!injected
                    && sql.startsWith("INSERT INTO ma_resource ")
                    && sql.contains("'managed-message-parts'")) {
                injected = true;
                switch (corruption) {
                    case "scope" ->
                            super.update(
                                    "UPDATE ma_resource SET session_scope_key = ?"
                                            + " WHERE resource_key = ?",
                                    "0".repeat(64),
                                    arguments[0]);
                    case "bytes" ->
                            super.update(
                                    "UPDATE ma_resource SET inline_bytes = ? WHERE"
                                            + " resource_key = ?",
                                    new byte[] {1},
                                    arguments[0]);
                    case "deletion" ->
                            super.update(
                                    "UPDATE ma_resource SET deletion_operation_key"
                                            + " = ? WHERE resource_key = ?",
                                    "0".repeat(64),
                                    arguments[0]);
                }
                return super.update(sql, arguments);
            }
            return changed;
        }
    }

    private void event(String item, String text) {
        tx.executeWithoutResult(
                status ->
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                "turn",
                                "item.output_text.delta",
                                Map.of("itemId", item, "text", text),
                                false,
                                "event-" + UUID.randomUUID()));
    }

    private void materialize() {
        tx.execute(status -> store.materializeNextBatch(tenant, session, 100));
    }

    static final class MutableClock extends Clock {
        private Instant instant = Instant.parse("2026-10-13T00:00:00Z");

        void advance(Duration duration) {
            instant = instant.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return instant;
        }
    }
}
