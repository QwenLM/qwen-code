package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
        tx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
        store =
                com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(
                        jdbc,
                        new ObjectMapper(),
                        clock,
                        ignored -> {},
                        new JdbcManagedWorkspaceRegistry(jdbc),
                        new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        tenant = "tenant-" + UUID.randomUUID();
        // This create writes the immutable ma_session_principal row: under the
        // unified ownership contract (94958d032422d, "unify unbound Session
        // authority under the ownership row") a present row is the sole
        // authority, so the mutations below must carry the owning actor — an
        // actorless caller answers 404 by design.
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
    void executionFactsReadNullableUnsignedWorkspaceGenerations() {
        assertThat(store.sessionsWithExecutionRegistryFacts(tenant, List.of(session))).isEmpty();
        byte[] actor = ManagedWorkspaceRegistry.actorKey(tenant, "actor");
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                        + " display_name, config_ref, policy_ref, state) VALUES"
                        + " (?, 'workspace', 7, 'storage', 'Workspace', 'config', 'policy', 'ACTIVE')",
                tenant);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES"
                        + " (?, 'workspace', ?, 'OPERATOR')",
                tenant, actor);
        jdbc.update(
                "UPDATE ma_session SET workspace_id = 'workspace', workspace_generation = 7,"
                        + " workspace_storage_id = 'storage', cwd_relative = '',"
                        + " context_config_ref = 'context', context_revision = 1,"
                        + " workspace_config_ref = 'config', workspace_policy_ref = 'policy',"
                        + " creator_actor_key = ? WHERE tenant_id = ? AND session_id = ?",
                actor, tenant, session);
        assertThat(store.sessionsWithExecutionRegistryFacts(tenant, List.of(session))).containsExactly(session);
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE tenant_id = ?", tenant);
        assertThat(store.sessionsWithExecutionRegistryFacts(tenant, List.of(session))).isEmpty();
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
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void messagePaginationKeepsItsRangeAndReadsCurrentContent() {
        for (int i = 0; i < 4; i++) {
            event("item-" + i, "text-" + i);
        }
        materialize();
        var first = page(null, 0, 2);
        assertThat(first.items()).hasSize(2);
        assertThat(first.hasMore()).isTrue();
        event("item-2", "changed");
        event("item-4", "new");
        materialize();
        var next = page(first.nextCursor(), 0, 2);
        assertThat(next.items()).extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("item-2", "item-3");
        assertThat(next.items().getFirst().content().stream().map(StoreModels.ItemPartRecord::text)
                .collect(java.util.stream.Collectors.joining())).isEqualTo("text-2changed");
        assertThat(next.throughSequence()).isEqualTo(first.throughSequence());
        assertThat(next.coveredSequence()).isGreaterThan(first.coveredSequence());
        assertThat(page(null, 0, 10).items()).hasSize(5);
        clock.advance(Duration.ofMinutes(31));
        assertThat(page(first.nextCursor(), 0, 2).items()).extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("item-2", "item-3");
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
                        messages()
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
    void releasedMessageBodiesAreCollectedOnlyWhenGcIsEnabled() {
        alignProjectionClock();
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        event("big", "b");
        materialize();
        var properties = new ManagedAgentProperties();
        var collector = new SessionResourceCollectionCollector(jdbc,
                new DataSourceTransactionManager(java.util.Objects.requireNonNull(jdbc.getDataSource())), properties);
        assertThat(collector.runOnce()).isFalse();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        properties.getToolPublication().setGcEnabled(true);
        assertThat(collector.runOnce()).isTrue();
        assertThat(resourceState(original)).isEqualTo("COLLECTED");
        assertThat(resourceState(messageBody("big"))).isEqualTo("REFERENCED");
        assertThat(messages().items()).singleElement()
                .satisfies(item -> assertThat(item.content().getFirst().text()).hasSize(70_001));
        assertThat(jdbc.queryForObject("SELECT retired_at FROM ma_session WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session)).isNull();
    }

    @Test
    void messageCursorDoesNotPinReleasedBodiesAndReadsTheirReplacement() {
        alignProjectionClock();
        event("small", "first");
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        var first = page(null, 0, 1);
        event("big", "b".repeat(70_000));
        materialize();
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("COLLECTED");
        assertThat(resourceState(messageBody("big"))).isEqualTo("REFERENCED");
        var next = page(first.nextCursor(), 0, 1);
        assertThat(next.items().getFirst().content().getFirst().text())
                .isEqualTo("a".repeat(70_000) + "b".repeat(70_000));
        assertThat(next.throughSequence()).isEqualTo(first.throughSequence());
        assertThat(next.coveredSequence()).isGreaterThan(first.coveredSequence());
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
    void projectionCleanupPreservesJournalReferencesAndRecoveryProtection() {
        alignProjectionClock();
        var privateBody = tx.execute(status -> com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc)
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
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        tx.executeWithoutResult(status -> {
            ManagedProjectionResourceCollector.release(jdbc, scope, "JOURNAL", scope);
            jdbc.update("DELETE FROM ma_resource_ref WHERE owner_kind = 'JOURNAL' AND owner_key = ?", scope);
            jdbc.update("UPDATE ma_session SET is_recovery_protected = TRUE WHERE tenant_id = ? AND session_id = ?", tenant, session);
        });
        projectionCollector().runOnce();
        assertThat(resourceState(original)).isEqualTo("REFERENCED");
        jdbc.update("UPDATE ma_session SET is_recovery_protected = FALSE WHERE tenant_id = ? AND session_id = ?", tenant, session);
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

    // A snapshot can predate the rename that won the tenant-scoped receipt key.
    @Test
    void aRacingSessionReusingARenameKeyAnswersConflictFromTheReceiptKey() {
        String other =
                tx.execute(
                                status ->
                                        store.insertSessionCommand(
                                                tenant,
                                                "actor",
                                                "CREATE_SESSION",
                                                "create-other",
                                                "create-other-digest",
                                                "qwen-code",
                                                null,
                                                "title",
                                                List.of(),
                                                null))
                        .sessionId();
        var winner = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
        winner.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        assertThatThrownBy(
                        () ->
                                tx.executeWithoutResult(
                                        status -> {
                                            // Pin this transaction's snapshot before the winner commits.
                                            jdbc.queryForObject(
                                                            "SELECT COUNT(*) FROM ma_request_receipt"
                                                                    + " WHERE namespace = 'SESSION_COMMAND'",
                                                            Long.class);
                                            winner.execute(ignored -> store.settleRenameSync(
                                                    tenant, "shared", "digest", other, "theirs", "actor"));
                                            store.settleRenameSync(tenant, "shared", "digest", session, "mine", "actor");
                                        }))
                .isInstanceOfSatisfying(
                        com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("title");
        // The synchronous settlement writes no delivery row at all.
        assertThat(jdbc.queryForObject(
                        "SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'RENAME' AND tenant_id = ?",
                        Long.class,
                        tenant))
                .isZero();
    }

    @Test
    void concurrentRenamesOfDifferentSessionsDoNotDeadlock() throws Exception {
        String other = tx.execute(status -> store.insertSessionCommand(
                tenant, "actor", "CREATE_SESSION", "create-other", "other-digest",
                "qwen-code", null, "other", List.of(), null)).sessionId();
        try (var threads = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var start = new java.util.concurrent.CyclicBarrier(2);
            var first = threads.submit(() -> {
                start.await(10, java.util.concurrent.TimeUnit.SECONDS);
                return tx.execute(status -> store.settleRenameSync(
                        tenant, "first", "first-digest", session, "first", "actor"));
            });
            var second = threads.submit(() -> {
                start.await(10, java.util.concurrent.TimeUnit.SECONDS);
                return tx.execute(status -> store.settleRenameSync(
                        tenant, "second", "second-digest", other, "second", "actor"));
            });
            assertThat(first.get(15, java.util.concurrent.TimeUnit.SECONDS).revision())
                    .isEqualTo(1);
            assertThat(second.get(15, java.util.concurrent.TimeUnit.SECONDS).revision())
                    .isEqualTo(1);
        }
        // Both titles settle synchronously; no delivery row is ever created.
        assertThat(store.requireSession(tenant, session).title()).isEqualTo("first");
        assertThat(store.requireSession(tenant, other).title()).isEqualTo("second");
        assertThat(jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'RENAME' AND tenant_id = ?",
                Long.class, tenant)).isZero();
    }

    @ParameterizedTest
    @ValueSource(booleans = {true, false})
    void anOpenFirstRenameDoesNotHoldBackAnotherSessionsFirstRename(boolean sameTenant) throws Exception {
        // Synchronous settlement writes no delivery row, so the tenant placement guard was the
        // only lock a first rename held across Sessions. Holding one rename's transaction open
        // must not hold back another Session's first rename, in the same tenant or another.
        String otherTenant = sameTenant ? tenant : tenant + "-other";
        String other = tx.execute(status -> store.insertSessionCommand(
                otherTenant, "actor", "CREATE_SESSION", "create-other", "other-digest",
                "qwen-code", null, "other", List.of(), null)).sessionId();
        var held = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        try (var threads = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
            var first = threads.submit(() -> tx.execute(status -> {
                var rename = store.settleRenameSync(
                        tenant, "first", "first-digest", session, "first", "actor");
                held.countDown();
                try {
                    // The hold must outlast the second rename's bound below, or a restored
                    // guard self-releases before that bound expires and the case passes.
                    release.await(30, java.util.concurrent.TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                return rename;
            }));
            try {
                if (!held.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                    first.get(1, java.util.concurrent.TimeUnit.SECONDS); // rethrows the settlement's cause
                    throw new AssertionError("first rename did not reach the held point");
                }
                var second = threads.submit(() -> tx.execute(status -> store.settleRenameSync(
                        otherTenant, "second", "second-digest", other, "second", "actor")));
                assertThat(second.get(15, java.util.concurrent.TimeUnit.SECONDS).revision()).isEqualTo(1);
            } finally {
                release.countDown();
            }
            assertThat(first.get(10, java.util.concurrent.TimeUnit.SECONDS).revision()).isEqualTo(1);
        }
    }

    @Test
    void messageCursorRejectsAnotherScopeAndInvalidUpperBound() throws Exception {
        event("a", "first");
        event("b", "second");
        materialize();
        String cursor = page(null, 0, 1).nextCursor();
        var mapper = new ObjectMapper();
        for (String field : List.of("scope", "through")) {
            var data = (com.fasterxml.jackson.databind.node.ObjectNode)
                    mapper.readTree(Base64.getUrlDecoder().decode(cursor));
            if (field.equals("scope")) {
                data.put(field, "0".repeat(64));
            } else {
                data.put(field, Long.MAX_VALUE);
            }
            String changed = Base64.getUrlEncoder().withoutPadding().encodeToString(mapper.writeValueAsBytes(data));
            assertThatThrownBy(() -> page(changed, 0, 1))
                    .isInstanceOf(ManagedAgentException.class).hasMessageContaining("cursor");
        }
        assertThat(page(cursor, 0, 1).items()).extracting(StoreModels.ItemRecord::itemId).containsExactly("b");
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
        assertThatThrownBy(() -> messages())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Message body resource is unavailable");
        event("big", "next");
        assertThatThrownBy(this::materialize)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Message body resource is unavailable");
    }

    @Test
    void messageUpdatesReleaseOldBodyWithoutRetainingPageCopies() {
        event("big", "a".repeat(70_000));
        event("last", "last");
        materialize();
        var first = page(null, 0, 1);
        String body = messageBody("big");
        event("big", "b");
        materialize();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?",
                Integer.class, body)).isZero();
        assertThat(page(first.nextCursor(), 0, 1).items()).extracting(StoreModels.ItemRecord::itemId)
                .containsExactly("last");
        assertThat(messages().items().getFirst().content().stream().map(StoreModels.ItemPartRecord::text)
                .collect(java.util.stream.Collectors.joining())).hasSize(70_001);
    }

    @Test
    void repeatableReadPagePairsWatermarkAndMessagesWhileAnotherTransactionCommits() throws Exception {
        var readers = java.util.Arrays.stream(ManagedAgentStore.class.getMethods())
                .filter(method -> method.getName().equals("findMessagePage")).toList();
        assertThat(readers).hasSize(2).allSatisfy(method -> {
            var annotation = method.getAnnotation(org.springframework.transaction.annotation.Transactional.class);
            assertThat(annotation).isNotNull();
            assertThat(annotation.transactionManager()).isEqualTo("managedAgentTransactionManager");
            assertThat(annotation.readOnly()).isTrue();
            assertThat(annotation.isolation()).isEqualTo(org.springframework.transaction.annotation.Isolation.REPEATABLE_READ);
        });
        event("a", "before");
        materialize();
        long original = messages().coveredSequence();
        var paused = new PausedMessageRead();
        try (var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var read = executor.submit(paused::read);
            try {
                assertThat(paused.entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                event("a", "after");
                materialize();
                assertThat(messages().items().getFirst().content().getFirst().text()).isEqualTo("beforeafter");
            } finally {
                paused.release.countDown();
            }
            var page = read.get(10, java.util.concurrent.TimeUnit.SECONDS);
            assertThat(page.coveredSequence()).isEqualTo(original);
            assertThat(page.items().getFirst().content().getFirst().text()).isEqualTo("before");
        }
    }

    @Test
    void repeatableReadPageRetainsOldBodyViewWhileReleasedBytesAreCollected() throws Exception {
        alignProjectionClock();
        event("big", "a".repeat(70_000));
        materialize();
        String original = messageBody("big");
        var paused = new PausedMessageRead();
        try (var executor = java.util.concurrent.Executors.newSingleThreadExecutor()) {
            var read = executor.submit(paused::read);
            try {
                assertThat(paused.entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                event("big", "b");
                materialize();
                projectionCollector().runOnce();
                assertThat(resourceState(original)).isEqualTo("COLLECTED");
            } finally {
                paused.release.countDown();
            }
            assertThat(read.get(10, java.util.concurrent.TimeUnit.SECONDS).items().getFirst().content().getFirst().text())
                    .isEqualTo("a".repeat(70_000));
        }
    }

    @Test
    void writerHeartbeatCompletesWhileMessagePageReadIsPaused() throws Exception {
        var privateStore = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc);
        String token = "a".repeat(32);
        var grant = tx.execute(status -> privateStore.acquireWriter(tenant, session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 60_000L)));
        event("a", "before");
        materialize();
        var paused = new PausedMessageRead();
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var read = executor.submit(paused::read);
            try {
                assertThat(paused.entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var heartbeat = executor.submit(() -> tx.execute(status -> privateStore.renewWriter(tenant, session, token,
                        new ManagedSessionStoreModels.RenewWriterRequest("workspace", "writer", grant.writerGeneration(), 60_000L))));
                assertThat(heartbeat.get(3, java.util.concurrent.TimeUnit.SECONDS).writerGeneration()).isEqualTo(grant.writerGeneration());
            } finally {
                paused.release.countDown();
            }
            assertThat(read.get(10, java.util.concurrent.TimeUnit.SECONDS).items()).hasSize(1);
        }
    }

    @Test
    void harnessOnlyHeadHasNoPrivateJournalReadAuthority() {
        String token = "a".repeat(32);
        jdbc.update(
                "INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, harness_session_id, session_id, head_kind, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, ?, 'HARNESS', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                RuntimeAdmissionFences.harnessDrainKey(
                        tenant),
                RuntimeAdmissionFences.harnessDrainKey(
                        session),
                tenant,
                session,
                session);
        var privateStore = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedSessionStore(jdbc);
        assertThatThrownBy(() -> privateStore.restore(tenant, "workspace", session, token))
                .isInstanceOfSatisfying(
                        ManagedAgentException.class,
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
                                                "payload",
                                                "actor"))
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
        var frozen = page(null, 0, 1);
        String oldBody =
                jdbc.queryForObject(
                        "SELECT body_resource_key FROM ma_message WHERE"
                                + " tenant_id = ? AND session_id = ? AND item_id = ?",
                        String.class,
                        tenant,
                        session,
                        "withdrawn");
        long first =
                messages().items().stream()
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
        materialize();
        assertThat(messages().items())
                .extracting(StoreModels.ItemRecord::itemId)
                .doesNotContain("withdrawn");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?"
                                        + " AND owner_kind = 'MESSAGE'",
                                Integer.class,
                                oldBody))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?",
                Integer.class, oldBody)).isZero();
        assertThatThrownBy(() -> page(frozen.nextCursor(), 0, 10))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("message_projection_changed"));
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
        assertThat(page(null, first, 10).items())
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
                                                "payload",
                                                "actor"))
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
                messages().items().stream()
                        .filter(item -> "same".equals(item.itemId()))
                        .findFirst()
                        .orElseThrow();
        tx.executeWithoutResult(
                status ->
                        store.retractContinuationOutput(
                                tenant, session, turn, "owner", "boot", "old"));
        materialize();
        assertThat(messages().items())
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
                com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(
                        duplicate,
                        new ObjectMapper(),
                        clock,
                        ignored -> {},
                        new JdbcManagedWorkspaceRegistry(duplicate),
                        new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        event("big", "x".repeat(70_000));
        if ("none".equals(corruption)) {
            tx.executeWithoutResult(status -> subject.materializeNextBatch(tenant, session, 100));
            assertThat(tx.execute(status -> subject.findMessagePage(tenant, session, null, 100, false)).items())
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

    private final class PausedMessageRead {
        private final java.util.concurrent.CountDownLatch entered = new java.util.concurrent.CountDownLatch(1);
        private final java.util.concurrent.CountDownLatch release = new java.util.concurrent.CountDownLatch(1);
        private final ManagedAgentStore subject;

        PausedMessageRead() {
            var paused = new ManagedSchemaJdbcTemplate(java.util.Objects.requireNonNull(jdbc.getDataSource())) {
                @Override
                public <T> List<T> query(String sql, org.springframework.jdbc.core.RowMapper<T> mapper, Object... arguments) {
                    var rows = super.query(sql, mapper, arguments);
                    if (sql.startsWith("SELECT m.item_id, m.first_sequence,")) {
                        entered.countDown();
                        try {
                            if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                                throw new IllegalStateException("Message page read was not released");
                            }
                        } catch (InterruptedException interrupted) {
                            Thread.currentThread().interrupt();
                            throw new IllegalStateException(interrupted);
                        }
                    }
                    return rows;
                }
            };
            subject = new ManagedAgentStore(paused, new ObjectMapper(), clock, ignored -> {},
                    new JdbcManagedWorkspaceRegistry(paused), new ManagedAgentProperties(),
                    new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        }

        StoreModels.MessagePage read() {
            return tx.execute(status -> subject.findMessagePage(tenant, session, null, 100, false));
        }
    }

    private StoreModels.MessagePage page(String cursor, long afterSequence, int limit) {
        return tx.execute(status -> store.findMessagePage(tenant, session, cursor, limit, false, afterSequence));
    }

    private StoreModels.MessagePage messages() {
        return page(null, 0, 100);
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
