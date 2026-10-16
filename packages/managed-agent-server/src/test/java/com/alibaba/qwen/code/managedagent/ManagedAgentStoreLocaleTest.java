package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

class ManagedAgentStoreLocaleTest {
    // Under a Turkish/Azeri default locale the default-locale fold turns
    // "FAILED" into "faıled", missing the switch arms and persisting the
    // item as still in_progress. Protocol tokens must fold with Locale.ROOT.
    @Test
    void foldsHarnessStatusesWithTheRootLocaleUnderATurkishDefault() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:locale-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                + ";LOCK_TIMEOUT=10000");
        ManagedSchema.initialize(source);
        JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(source);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), events -> {},
                mock(ManagedWorkspaceRegistry.class),
                new ManagedAgentProperties());

        Admission session = store.insertSessionCommand("tenant-locale",
                "CREATE_SESSION", "create-key", "digest-create", "qwen-code",
                "1", null, List.of(), null);
        Admission turn = store.insertTurnCommand("tenant-locale", "SUBMIT",
                "submit-key", "digest-submit", session.sessionId(),
                List.of(Map.of("type", "text", "text", "hi")), "payload");

        Locale previous = Locale.getDefault();
        Locale.setDefault(new Locale("tr", "TR"));
        try {
            store.appendPublicEventIfAbsent("tenant-locale",
                    session.sessionId(), turn.turnId(),
                    "item.tool_call.updated",
                    Map.of("itemId", "item-tool-1", "status", "FAILED"),
                    false, "src-locale");
            store.materializeNextBatch("tenant-locale", session.sessionId(),
                    32);
        } finally {
            Locale.setDefault(previous);
        }

        String itemStatus = jdbc.queryForObject(
                "SELECT item_status FROM ma_message WHERE tenant_id"
                        + " = ? AND session_id = ? AND item_id = ?",
                String.class, "tenant-locale", session.sessionId(),
                "item-tool-1");
        assertThat(itemStatus).isEqualTo("failed");
    }
}
