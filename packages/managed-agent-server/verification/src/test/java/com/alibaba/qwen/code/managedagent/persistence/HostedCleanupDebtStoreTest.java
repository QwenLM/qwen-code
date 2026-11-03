package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The debt scan reads the durable owed projection plus its descriptor; it
 * must never turn a foreign or unreadable descriptor into a cleanup load,
 * it must leave a Session with live work to that Turn's own driver, and its
 * keyset cursor must advance past an unreadable prefix so later debts are
 * still reached.
 */
@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:hosted-cleanup-debt;"
                + "MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
@Transactional
class HostedCleanupDebtStoreTest {
    private static final String TENANT = "tenant-cleanup-debt";
    private static final String WORKSPACE = "workspace-cleanup-debt";

    @Autowired
    private HostedCleanupDebtStore store;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void listsAnOwedDescriptorForItsOwnSession() {
        String session = session("ready");
        String prompt = UUID.randomUUID().toString();
        owed(TENANT, WORKSPACE, session, prompt, null);

        var debts = store.findOwed(10, -1, "").debts();

        assertThat(debts).singleElement().satisfies(debt -> {
            assertThat(debt.tenantId()).isEqualTo(TENANT);
            assertThat(debt.workspaceId()).isEqualTo(WORKSPACE);
            assertThat(debt.sessionId()).isEqualTo(session);
            assertThat(debt.promptId()).isEqualTo(prompt);
            assertThat(debt.ownerKey())
                    .isEqualTo(ManagedSchemaKeys.key("hosted-cleanup", prompt));
        });
    }

    @Test
    void skipsASessionWhoseTurnIsStillActive() {
        String session = session("running");
        owed(TENANT, WORKSPACE, session, UUID.randomUUID().toString(), null);
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id,"
                        + " input_json, payload_digest, status, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, ?, ?, '{}', 'd', 'RUNNING', 1, 1)",
                TENANT, session, UUID.randomUUID().toString(), UUID.randomUUID().toString());

        assertThat(store.findOwed(10, -1, "").debts()).isEmpty();
    }

    @Test
    void skipsADescriptorThatNamesAnotherSession() {
        String session = session("foreign");
        owed(TENANT, WORKSPACE, session, UUID.randomUUID().toString(),
                descriptor(TENANT, WORKSPACE, session("elsewhere"), UUID.randomUUID().toString()));

        assertThat(store.findOwed(10, -1, "").debts()).isEmpty();
    }

    @Test
    void skipsADebtWithoutAWorkspaceOrInlineDescriptor() {
        String session = session("no-workspace");
        owed(TENANT, null, session, UUID.randomUUID().toString(), null);

        assertThat(store.findOwed(10, -1, "").debts()).isEmpty();
    }

    @Test
    void skipsADescriptorStoredOutsideTheDatabase() {
        String session = session("external");
        owed(TENANT, WORKSPACE, session, UUID.randomUUID().toString(), null, "OBJECT_STORE");

        assertThat(store.findOwed(10, -1, "").debts()).isEmpty();
    }

    @Test
    void advancesPastAnUnreadablePrefixToLaterDebts() {
        String tenant = "tenant-starvation";
        for (int index = 1; index <= 20; index++) {
            String stuck = session(tenant, "stuck-" + index);
            owed(tenant, WORKSPACE, stuck, UUID.randomUUID().toString(),
                    "not json".getBytes(StandardCharsets.UTF_8), "MYSQL_INLINE", index);
        }
        String goodSession = session(tenant, "good");
        String goodPrompt = UUID.randomUUID().toString();
        owed(tenant, WORKSPACE, goodSession, goodPrompt, null, "MYSQL_INLINE", 21);

        // The first page is twenty raw rows whose descriptors are all
        // unreadable: no valid debt, but the cursor must still advance and the
        // page must not look exhausted, or the valid debt behind them starves.
        var first = store.findOwed(20, -1, "");
        assertThat(first.debts()).isEmpty();
        assertThat(first.exhausted()).isFalse();

        var second = store.findOwed(20, first.nextCreate(), first.nextOwnerKey());
        assertThat(second.debts()).singleElement().satisfies(debt -> {
            assertThat(debt.sessionId()).isEqualTo(goodSession);
            assertThat(debt.promptId()).isEqualTo(goodPrompt);
        });
        assertThat(second.exhausted()).isTrue();
    }

    private String session(String suffix) {
        return session(TENANT, suffix);
    }

    private String session(String tenant, String suffix) {
        String session = "session-" + suffix + "-" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified)"
                + " VALUES (?, ?, 'agent-cleanup', 1, 1)", tenant, session);
        return session;
    }

    private void owed(String tenant, String workspace, String session, String prompt,
            byte[] bytes) {
        owed(tenant, workspace, session, prompt, bytes, "MYSQL_INLINE", 1);
    }

    private void owed(String tenant, String workspace, String session, String prompt,
            byte[] bytes, String storageKind) {
        owed(tenant, workspace, session, prompt, bytes, storageKind, 1);
    }

    private void owed(String tenant, String workspace, String session, String prompt,
            byte[] bytes, String storageKind, long gmtCreate) {
        byte[] body = bytes == null ? descriptor(tenant, workspace, session, prompt) : bytes;
        String resourceId = "cleanup-" + UUID.randomUUID();
        String resourceKey = UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id,"
                        + " workspace_id, session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 'hosted-turn-cleanup', 1, ?, ?,"
                        + " ?, ?, 'REFERENCED', ?)",
                resourceKey, com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session), tenant,
                workspace, session, resourceId, body.length, "d", storageKind, body, gmtCreate);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                        + " owner_revision, resource_key, tenant_id, workspace_id, session_id,"
                        + " journal_revision, resource_id, gmt_create, runtime_binding_key)"
                        + " VALUES (?, 'HOSTED_CLEANUP', ?, 1, ?, ?, ?, ?, 1, ?, ?, ?)",
                com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session),
                ManagedSchemaKeys.key("hosted-cleanup", prompt), resourceKey, tenant, workspace,
                session, resourceId, gmtCreate, "binding-" + UUID.randomUUID());
    }

    private static byte[] descriptor(String tenant, String workspace, String session,
            String prompt) {
        return ("{\"v\":1,\"sessionKey\":{\"tenantId\":\"" + tenant + "\",\"workspaceId\":\""
                + workspace + "\",\"sessionId\":\"" + session + "\"},\"promptId\":\"" + prompt
                + "\",\"runtimeSessionId\":\"" + prompt + "\",\"bindingId\":\"binding\","
                + "\"generation\":\"1\",\"workspaceGeneration\":\"1\","
                + "\"fileHistoryTurnId\":\"" + prompt + "\"}")
                .getBytes(StandardCharsets.UTF_8);
    }
}
