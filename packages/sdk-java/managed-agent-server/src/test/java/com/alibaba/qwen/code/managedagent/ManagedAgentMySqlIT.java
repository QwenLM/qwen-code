package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class ManagedAgentMySqlIT {
    @Test
    void materializesReplayableItemsAndSnapshotsOnMySql() {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("1")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                "mysql-upgrade", "session_upgrade", "qwen-code", "IDLE",
                1L, 1L);
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                Integer.class, "mysql-upgrade", "session_upgrade",
                "message_projection")).isEqualTo(1);
        ManagedAgentStore store = new ManagedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {
                });
        String tenant = "mysql-projection";
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "hello"));
        Admission admission = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "mysql-create",
                "sha256:" + "a".repeat(64), "qwen-code", null, input,
                "sha256:" + "b".repeat(64));
        String assistantItem = "item_" + admission.turnId() + "_assistant";
        String part = "part_" + admission.turnId() + "_output_text";
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "hel"), false, "mysql:1");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "lo"), false, "mysql:2");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.tool_call.updated", Map.of(
                        "toolCallId", "legacy-tool", "name", "read_file",
                        "status", "completed"), false, "mysql:legacy-tool");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "turn.completed", Map.of(), true,
                "mysql:3");

        assertThat(store.materializeNextBatch(tenant, admission.sessionId(),
                200).advanced()).isTrue();
        assertThat(store.findSnapshot(tenant, admission.sessionId()))
                .get().satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence()).isEqualTo(6);
                    assertThat(snapshot.items()).hasSize(3)
                            .filteredOn(item ->
                                    "assistant".equals(item.role()))
                            .filteredOn(item -> "message".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.content()).singleElement()
                                        .extracting(content -> content.text())
                                        .isEqualTo("hello");
                            });
                    assertThat(snapshot.items())
                            .filteredOn(item -> "tool_call".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.attributes())
                                        .containsEntry("toolCallId",
                                                "legacy-tool");
                            });
                });
        assertThat(store.materializeNextBatch(tenant, admission.sessionId(),
                200).advanced()).isFalse();
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
