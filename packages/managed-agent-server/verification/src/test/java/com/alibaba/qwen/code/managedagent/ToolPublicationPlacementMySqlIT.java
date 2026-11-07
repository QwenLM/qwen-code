package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceLifecycleStore;
import com.fasterxml.jackson.databind.JsonNode;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Ordinary publication lanes run without placement (design
 * 2026-11-04-managed-publication-placement): they lock the Session root first,
 * read a Session-isolated original binding without a lock and share a
 * Workspace-shared one. A binding owner holds placement and the binding row,
 * and a Session-isolated binding's owner then takes the Session root, as
 * {@code lockBindingControl} does. Neither shape may deadlock with a lane.
 */
class ToolPublicationPlacementMySqlIT {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void ordinaryRenewBesideABindingOwnerDoesNotDeadlock(boolean sessionIsolated) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "publication_placement_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema),
                    user, password);
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var journal = sessionIsolated ? PublicationJournalFixture.createSessionIsolated(source)
                    : PublicationJournalFixture.create(source);
            JsonNode reserved = journal.reserve();
            byte[] binding = journal.binding.path("runtimeBindingId").asText().getBytes(StandardCharsets.UTF_8);
            long deadlocksBefore = MySqlLockProbe.innodbDeadlocks(admin);
            try (var pool = Executors.newSingleThreadExecutor()) {
                Future<JsonNode> renew;
                var owner = journal.manager.getTransaction(new DefaultTransactionDefinition());
                try {
                    WorkspaceLifecycleStore.lockPlacement(journal.jdbc, "tenant-1");
                    journal.jdbc.queryForList("SELECT binding_id FROM ma_runtime_binding WHERE binding_id = ?"
                            + " FOR UPDATE", binding);
                    renew = pool.submit(() -> journal.store.apply(journal.request("renew"), WRITER_TOKEN,
                            PUBLICATION_TOKEN));
                    if (sessionIsolated) {
                        // The lane reads the binding without a lock below its root, so it ends
                        // while the owner holds the binding; the owner then gets the root.
                        assertThat(renew.get(10, TimeUnit.SECONDS).path("state").asText())
                                .isEqualTo(reserved.path("state").asText());
                        journal.jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ?"
                                + " AND session_id = ? FOR UPDATE", "tenant-1", "session-1");
                    } else {
                        // The lane holds its root and shares the binding behind the owner, whose
                        // Workspace-shared binding changes never take a Session root.
                        MySqlLockProbe.awaitLockWaits(admin, schema, 1, "the renew behind the binding owner");
                        assertThat(renew.isDone()).isFalse();
                    }
                } finally {
                    journal.manager.rollback(owner);
                }
                assertThat(renew.get(30, TimeUnit.SECONDS).path("state").asText())
                        .isEqualTo(reserved.path("state").asText());
            }
            assertThat(MySqlLockProbe.innodbDeadlocks(admin) - deadlocksBefore).isZero();
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }
}
