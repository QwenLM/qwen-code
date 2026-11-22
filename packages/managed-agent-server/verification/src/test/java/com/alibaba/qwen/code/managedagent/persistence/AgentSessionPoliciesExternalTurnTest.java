package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class AgentSessionPoliciesExternalTurnTest {
    private static final String TENANT = "tenant-a";
    private static final String SESSION_ID = "session-a";
    private static final List<Map<String, Object>> PINNED = List.of(
            Map.of("name", "review", "description", "d", "body", "b"));

    private static SessionRecord externalSession() {
        return new SessionRecord(TENANT, SESSION_ID, "qwen-code", null, null,
                "ACTIVE", null, null, 0, 0, 0, 1, 1, null, 1,
                new ContextBinding(TENANT, "workspace-a", 1, "storage-a", ".",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1),
                "default", WorkspaceToolProfiles.EXTERNAL_FILES, null, 0);
    }

    private static AgentSessionPolicies policies(JdbcManagedSessionSkills skills) {
        var workspaces = mock(JdbcManagedWorkspaceRegistry.class);
        when(workspaces.externalFilesAllowed(any())).thenReturn(true);
        when(workspaces.accessOf(anyString(), anyString(), anyString()))
                .thenReturn(WorkspaceAccess.OWNER);
        return new AgentSessionPolicies(
                mock(AgentEventJournal.class),
                mock(AgentSessionQueries.class),
                mock(AgentStoreRows.class),
                mock(WorktreeFiles.class),
                mock(HarnessRules.class),
                mock(JdbcManagedExtensionRecordStore.class),
                mock(JdbcTemplate.class),
                new ObjectMapper(),
                Clock.systemUTC(),
                "default",
                workspaces,
                "1",
                List.of(),
                List.of(),
                List.of(),
                mock(JdbcManagedAgentDefinitionStore.class),
                skills,
                true,
                false);
    }

    /** The creation receipt the turn gate reads, in the schema writer shape. */
    private static JdbcTemplate receiptSchema() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:session-skills-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        source.setUser("sa");
        var jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE ma_request_receipt (receipt_key VARCHAR(64) NOT NULL,"
                + " namespace VARCHAR(32) NOT NULL, tenant_key VARCHAR(64) NOT NULL,"
                + " tenant_id VARCHAR(512) NOT NULL, scope_kind VARCHAR(16) NOT NULL,"
                + " scope_key VARCHAR(64) NOT NULL, scope_id VARCHAR(512) NOT NULL,"
                + " idempotency_key VARCHAR(2048) NOT NULL,"
                + " idempotency_digest VARCHAR(64) NOT NULL,"
                + " request_digest VARCHAR(80) NOT NULL, state VARCHAR(32) NOT NULL,"
                + " session_id VARCHAR(512), result_json LONGTEXT)");
        jdbc.update("INSERT INTO ma_request_receipt (receipt_key, namespace,"
                        + " tenant_key, tenant_id, scope_kind, scope_key, scope_id,"
                        + " idempotency_key, idempotency_digest, request_digest,"
                        + " state, session_id) VALUES ('key', 'SESSION_CREATE_ACTOR',"
                        + " ?, ?, 'SESSION', 'scope', ?, 'idempotency', 'digest',"
                        + " 'request', 'ADMITTED', ?)",
                ManagedSchemaKeys.key(TENANT), TENANT, SESSION_ID, SESSION_ID);
        return jdbc;
    }

    @Test
    void externalTurnAdmitsThePinnedCatalogAndStillRefusesAnInitialSelection() {
        // The pinned catalog is content the turn serves; the admission must not
        // read it as an extension lane. The receipt is the writer's own rows, so
        // the gate is exercised against the persisted snapshot, not a stub:
        // re-adding the non-empty check to the refusal reddens the admitted case.
        var skills = new JdbcManagedSessionSkills(receiptSchema(),
                new ObjectMapper(), new RequestDigests(),
                mock(JdbcManagedAgentDefinitionStore.class));
        skills.save(TENANT, SESSION_ID, PINNED);
        var policies = policies(skills);
        var session = externalSession();
        var input = List.<Map<String, Object>>of(
                Map.of("type", "input_text", "text", "hi"));

        assertThat(skills.effective(session)).isEqualTo(PINNED);
        assertThatCode(() -> policies.requireExternalTurnAllowed(
                TENANT, "actor-a", SESSION_ID, session, input))
                .doesNotThrowAnyException();

        // An initial selection can only reach an external Session through a
        // path admission refuses, so the turn gate keeps refusing it.
        skills.saveInitialSelection(TENANT, SESSION_ID, List.of());
        assertThatThrownBy(() -> policies.requireExternalTurnAllowed(
                TENANT, "actor-a", SESSION_ID, session, input))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
    }
}
