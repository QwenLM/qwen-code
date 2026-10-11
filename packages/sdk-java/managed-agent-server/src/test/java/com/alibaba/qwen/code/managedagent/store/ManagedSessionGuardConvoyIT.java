package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Witness for #13800: an externally held tenant guard row must not wedge
 * ordinary traffic of unrelated Sessions; admissions that legitimately
 * fence fail fast with a named error instead of out-waiting the caller.
 */
class ManagedSessionGuardConvoyIT {

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
        schema = "gc_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @Test
    void heldTenantGuardsDoNotWedgeUnrelatedSessions() throws Exception {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transactions = new TransactionTemplate(manager);
        var store = new ManagedSessionStore(jdbc);
        String tenant = "tenant-a";
        String workspace = "workspace-a";
        String token = "w".repeat(32);
        var grant = transactions.execute(ignored -> store.acquireWriter(tenant, "victim", token,
                new AcquireWriterRequest(workspace, "writer-victim", 60_000L)));
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "blocked", token,
                new AcquireWriterRequest(workspace, "writer-blocked", 60_000L)));
        var journalWriter = transactions.execute(ignored ->
                new ExtensionRecordJournal(store, tenant, workspace, "committer").open());
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = 'BLOCKED_RESOURCE',"
                + " recovery_detail_code = 'a2-witness' WHERE tenant_id = ? AND session_id = ?",
                tenant, "blocked");

        var holdTx = manager.getTransaction(new DefaultTransactionDefinition());
        // Hold both tenant-wide guards the way a fat lifecycle transaction
        // would, on a connection the test never commits.
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
        try {
            var templates = ManagedHookRecordContractTest.fixtures().get("templates");
            var data = new CommitResource("hook-data", "hook-data", 1, 2, sha256("{}"), "e30=");
            ObjectNode registration = templates.get("hook_registration").deepCopy();
            registration.withObject("/catalogRef").put("digest", data.digest());
            var request = journalWriter.requestDomain("witness-hold", "hook_registration",
                    registration, List.of(data), System.currentTimeMillis());
            try (var pool = Executors.newFixedThreadPool(4)) {
                var renewed = pool.submit(() -> transactions.execute(ignored -> store.renewWriter(tenant, "victim", token,
                        new RenewWriterRequest(workspace, "writer-victim", grant.writerGeneration(), 60_000L))));
                var authorized = pool.submit(() -> {
                    transactions.executeWithoutResult(ignored -> store.authorizeOrdinary(tenant, "victim", token,
                            new AuthorizeLifecycleRequest(workspace, "writer-victim", grant.writerGeneration())));
                    return null;
                });
                var committed = pool.submit(() -> transactions.execute(ignored -> journalWriter.commit(request)));
                var blockedAgain = pool.submit(() -> transactions.execute(ignored -> store.blockRecovery(tenant, "blocked", token,
                        new BlockRecoveryRequest(workspace, "writer-blocked", 1, "BLOCKED_RESOURCE", "a2-witness"))));
                renewed.get(30, TimeUnit.SECONDS);
                authorized.get(30, TimeUnit.SECONDS);
                committed.get(30, TimeUnit.SECONDS);
                blockedAgain.get(30, TimeUnit.SECONDS);
            }

            // The admission that legitimately fences fails fast and named.
            // It must run on a fresh thread: on the holder's own Thread the
            // call would join the held transaction and see no contention.
            long before = System.nanoTime();
            try (var admissionPool = Executors.newSingleThreadExecutor()) {
                assertThatThrownBy(() -> admissionPool.submit(() -> transactions.executeWithoutResult(ignored ->
                        store.acquireWriter(tenant, "late", token,
                                new AcquireWriterRequest(workspace, "writer-late", 60_000L))))
                        .get(30, TimeUnit.SECONDS))
                        .isInstanceOf(java.util.concurrent.ExecutionException.class)
                        .satisfies(error -> {
                            var cause = error.getCause();
                            assertThat(cause).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ApiException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long elapsedMs = (System.nanoTime() - before) / 1_000_000;
            assertThat(elapsedMs).isLessThan(25_000);

            // The lifecycle-authorisation lane fences through the same
            // bounded guards: a held row answers named and fast rather than
            // waiting out the caller's own budget behind it.
            long lifecycleBefore = System.nanoTime();
            try (var lifecyclePool = Executors.newSingleThreadExecutor()) {
                assertThatThrownBy(() -> lifecyclePool.submit(() -> transactions.executeWithoutResult(ignored ->
                        store.authorizeLifecycle(tenant, "victim", token,
                                new AuthorizeLifecycleRequest(workspace, "writer-victim", grant.writerGeneration()),
                                new RuntimeLifecycleAuthority("witness-operation", 1))))
                        .get(30, TimeUnit.SECONDS))
                        .isInstanceOf(java.util.concurrent.ExecutionException.class)
                        .satisfies(error -> {
                            var cause = error.getCause();
                            assertThat(cause).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ApiException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long lifecycleElapsedMs = (System.nanoTime() - lifecycleBefore) / 1_000_000;
            assertThat(lifecycleElapsedMs).isLessThan(25_000);
        } finally {
            manager.rollback(holdTx);
        }

        // The hold is gone; the same admission now succeeds.
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "late", token,
                new AcquireWriterRequest(workspace, "writer-late", 60_000L)));
        // And the blocked neighbour reports its own blocked state unchanged.
        assertThat(jdbc.queryForObject("SELECT CONCAT(recovery_status, ':', recovery_detail_code) FROM"
                + " qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, "blocked")).isEqualTo("BLOCKED_RESOURCE:a2-witness");
    }

    private static String sha256(String value) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }
}
