package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Lifecycle commands as the server left them before V17: an archive and a
 * delete that waited for a retry, a finished archive and a pending rename.
 */
final class LegacyLifecycleCommands {
    private static final RequestDigests DIGESTS = new RequestDigests();

    record Sessions(String archiving, String deleting, String archived,
            String renaming) {
    }

    private LegacyLifecycleCommands() {
    }

    // Writes V15 rows.
    static Sessions insert(JdbcTemplate jdbc, String tenant) {
        Sessions sessions = new Sessions(session(jdbc, tenant, "ARCHIVING",
                ManagedAgentServerIntegrationTest.FixtureHarness.BOOT_ID),
                session(jdbc, tenant, "DELETING", null),
                session(jdbc, tenant, "ARCHIVED", null),
                session(jdbc, tenant, "ACTIVE", null));
        command(jdbc, tenant, "ARCHIVE_SESSION", "archive",
                sessions.archiving(), "PENDING", "ACTIVE");
        command(jdbc, tenant, "DELETE_SESSION", "delete", sessions.deleting(),
                "PENDING", "ARCHIVED");
        command(jdbc, tenant, "ARCHIVE_SESSION", "archived",
                sessions.archived(), "COMPLETED", "ACTIVE");
        command(jdbc, tenant, "RENAME_SESSION", "rename", sessions.renaming(),
                "PENDING", "ACTIVE");
        return sessions;
    }

    /**
     * Checks that V17 made the waiting archive and delete pending operations
     * under their keys and left the other commands alone.
     *
     * @return the archive and the delete operation IDs
     */
    static List<String> assertMigrated(JdbcTemplate jdbc, String tenant,
            Sessions sessions) {
        List<Map<String, Object>> operations = jdbc.queryForList("SELECT"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before FROM managed_agent_operation"
                        + " WHERE tenant_id = ? ORDER BY operation_kind",
                tenant);
        assertThat(operations).extracting(row -> row.get("session_id"),
                row -> row.get("operation_kind"),
                row -> row.get("idempotency_key"),
                row -> row.get("request_digest"),
                row -> row.get("session_status_before"))
                .containsExactly(
                        tuple(sessions.archiving(), "ARCHIVE", "archive",
                                digest(sessions.archiving(),
                                        "ARCHIVE_SESSION"), "ACTIVE"),
                        tuple(sessions.deleting(), "DELETE", "delete",
                                digest(sessions.deleting(), "DELETE_SESSION"),
                                "ARCHIVED"));
        assertThat(operations).allSatisfy(row -> {
            assertThat((String) row.get("operation_id"))
                    .matches("op_[0-9a-f]{32}");
            assertThat(row.get("actor_digest")).isEqualTo("");
            assertThat(row.get("state")).isEqualTo("PENDING");
            assertThat(row.get("admission_stage")).isEqualTo("JAVA_DURABLE");
            assertThat(row.get("delivery_state")).isEqualTo("PENDING");
        });
        List<String> ids = operations.stream()
                .map(row -> (String) row.get("operation_id")).toList();
        assertThat(ids).doesNotHaveDuplicates();
        assertThat(jdbc.queryForList("SELECT idempotency_key, command_status"
                        + " FROM managed_agent_command WHERE tenant_id = ?"
                        + " AND operation <> 'CREATE_SESSION' ORDER BY"
                        + " idempotency_key", tenant))
                .containsExactly(
                        Map.of("idempotency_key", "archive",
                                "command_status", "MIGRATED"),
                        Map.of("idempotency_key", "archived",
                                "command_status", "COMPLETED"),
                        Map.of("idempotency_key", "delete",
                                "command_status", "MIGRATED"),
                        Map.of("idempotency_key", "rename",
                                "command_status", "PENDING"));
        return ids;
    }

    private static String session(JdbcTemplate jdbc, String tenant,
            String status, String harnessBootId) {
        String sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, harness_boot_id,"
                        + " created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1,"
                        + " 1)",
                tenant, sessionId, "qwen-code", status, harnessBootId);
        return sessionId;
    }

    private static void command(JdbcTemplate jdbc, String tenant,
            String operation, String key, String sessionId, String status,
            String statusBefore) {
        jdbc.update("INSERT INTO managed_agent_command (tenant_id, operation,"
                        + " idempotency_key, request_digest, session_id,"
                        + " created_at, command_status, updated_at,"
                        + " session_status_before) VALUES (?, ?, ?, ?, ?, 1,"
                        + " ?, 1, ?)",
                tenant, operation, key, digest(sessionId, operation),
                sessionId, status, statusBefore);
    }

    private static String digest(String sessionId, String operation) {
        return DIGESTS.digest(Map.of("sessionId", sessionId, "operation",
                operation));
    }
}
