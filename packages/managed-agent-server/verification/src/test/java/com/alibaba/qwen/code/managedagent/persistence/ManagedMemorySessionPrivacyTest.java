package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryRepository;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.session.ManagedUserMessagePolicy;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public class ManagedMemorySessionPrivacyTest {
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedAgentStore store;
    private JdbcManagedWorkspaceRegistry workspaces;
    private ManagedAgentService service;
    private HarnessConnector harness;
    private final String tenant = "memory-privacy-" + UUID.randomUUID();

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:memory-privacy-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        workspaces = new JdbcManagedWorkspaceRegistry(jdbc);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {}, workspaces, properties, new SdkHarnessRules());
        harness = mock(HarnessConnector.class);
        when(harness.supportsPersonalMemory()).thenReturn(true);
        service = new ManagedAgentService(store, new RequestDigests(), mock(HarnessCoordinator.class),
                harness, workspaces, new SdkHarnessRules());
        ReflectionTestUtils.setField(service, "memory", mock(MemoryRepository.class));
        for (String workspace : List.of("workspace-a", "workspace-b")) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id,workspace_id,workspace_generation,storage_id,"
                            + "display_name,config_ref,policy_ref,state) VALUES (?,?,1,?,'Workspace',?,?,'ACTIVE')",
                    tenant, workspace, "storage-" + workspace, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF);
            for (String actor : List.of("owner", "other")) {
                jdbc.update("INSERT INTO ma_workspace_access (tenant_id,workspace_id,actor_id,role) VALUES (?,?,?,'OPERATOR')",
                        tenant, workspace, actorKey(actor));
            }
        }
    }

    @Test
    void bindingIsAtomicAndOnlyItsOwnerCanReuseItAcrossWorkspaces() {
        String memory = memory("owner");
        String first = workspaceSession("owner", "workspace-a", memory);
        String second = workspaceSession("owner", "workspace-b", memory);
        assertThat(store.requireSession(tenant, first).memoryStoreId()).isEqualTo(memory);
        assertThat(store.requireSession(tenant, second).ownerOnly()).isTrue();
        int before = sessionCount();
        assertThatThrownBy(() -> workspaceSession("other", "workspace-a", memory))
                .isInstanceOf(ManagedAgentException.class);
        assertThat(sessionCount()).isEqualTo(before);
        assertThatThrownBy(() -> transaction.execute(status -> store.insertSessionCommand(
                tenant, "other", "CREATE_SESSION", "foreign-memory", "digest", "qwen-code", null,
                "title", List.of(), null, null, memory))).isInstanceOf(ManagedAgentException.class);
        assertThat(sessionCount()).isEqualTo(before);
        assertThat(store.findCommand(tenant, "CREATE_SESSION", "foreign-memory")).isEmpty();
    }

    @Test
    void privateSessionIsHiddenBeforeReadsCommandsAndReplays() {
        String memory = memory("owner");
        String session = workspaceSession("owner", "workspace-a", memory);
        String shared = workspaceSession("owner", "workspace-a", null);
        assertThat(service.requireReadableSession(tenant, "other", shared).sessionId()).isEqualTo(shared);
        notFound(() -> service.requireReadableSession(tenant, "other", session));
        notFound(() -> service.submitTurn(tenant, "other", "submit", session, List.of(new InputBlock("text", "hello"))));
        notFound(() -> service.cancelTurn(tenant, "other", "cancel", session, "turn"));
        notFound(() -> service.renameSession(tenant, "other", "rename", session, "renamed"));
        notFound(() -> new ManagedUserMessagePolicy(store, new RequestDigests(), harness, workspaces)
                .authorizeUserMessageActor(tenant, "other", session));
        notFound(() -> transaction.execute(status -> store.changeSessionModel(
                tenant, "other", session, "model", "digest", "model", 0, true)));
        notFound(() -> transaction.execute(status -> store.changeSessionApproval(
                tenant, "other", session, "approval", "digest", "default", 0, true, true)));
        notFound(() -> transaction.execute(status -> store.beginContextCompression(
                tenant, session, "other", "actor-digest", "compress", "digest", 0, true)));
        assertThat(service.requireReadableSession(tenant, "owner", session).ownerOnly()).isTrue();
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id=? AND workspace_id=? AND actor_id=?",
                tenant, "workspace-a", actorKey("owner"));
        notFound(() -> service.requireReadableSession(tenant, "owner", session));
    }

    @Test
    void legacyCreationBindsMemoryAndItsReplayNeverEscapesToAnotherActor() {
        String memory = memory("owner");
        var first = transaction.execute(status -> service.createSession(tenant, "owner", "create-personal",
                "qwen-code", null, "title", Map.of(), List.of(), null, memory));
        assertThat(store.requireSession(tenant, first.sessionId()).ownerOnly()).isTrue();
        assertThat(service.getPublicSession(tenant, "owner", first.sessionId()).memoryStoreId()).isEqualTo(memory);
        notFound(() -> service.createSession(tenant, "other", "create-personal", "qwen-code", null,
                "title", Map.of(), List.of(), null, null));
        assertThatThrownBy(() -> service.createSession(tenant, "owner", "create-personal", "qwen-code", null,
                "title", Map.of(), List.of(), null, null)).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        ReflectionTestUtils.setField(service, "memory", null);
        assertThat(service.createSession(tenant, "owner", "create-personal", "qwen-code", null,
                "title", Map.of(), List.of(), null, memory).sessionId()).isEqualTo(first.sessionId());
        assertThatThrownBy(() -> service.createSession(tenant, "owner", "new-personal", "qwen-code", null,
                "title", Map.of(), List.of(), null, memory)).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("memory_disabled"));
    }

    @Test
    void creationReplayRechecksPrivacyWhenAConcurrentOwnerAppears() {
        String memory = memory("owner");
        transaction.execute(status -> service.createSession(tenant, "owner", "racing-create",
                "qwen-code", null, "title", Map.of(), List.of(), null, memory));
        var racedStore = org.mockito.Mockito.spy(store);
        org.mockito.Mockito.doReturn(java.util.Optional.empty(), store.findCommand(tenant, "CREATE_SESSION", "racing-create"))
                .when(racedStore).findCommand(tenant, "CREATE_SESSION", "racing-create");
        var racedService = new ManagedAgentService(racedStore, new RequestDigests(), mock(HarnessCoordinator.class),
                harness, workspaces, new SdkHarnessRules());
        notFound(() -> racedService.createSession(tenant, "other", "racing-create", "qwen-code", null,
                "title", Map.of(), List.of(), null, memory));
    }

    @Test
    void paginationFiltersPrivateSessionsInsideTheQuery() {
        String ownerMemory = memory("owner");
        String otherMemory = memory("other");
        String personal = workspaceSession("owner", "workspace-a", ownerMemory);
        String hidden = workspaceSession("other", "workspace-a", otherMemory);
        String shared = workspaceSession("other", "workspace-a", null);
        List<String> visible = new ArrayList<>();
        Long before = null;
        String after = null;
        while (true) {
            var page = store.listSessions(tenant, "owner", before, after, 1);
            page.sessions().forEach(session -> visible.add(session.sessionId()));
            if (!page.hasMore()) {
                break;
            }
            var last = page.sessions().getLast();
            before = last.createdAt();
            after = last.sessionId();
        }
        assertThat(visible).containsExactlyInAnyOrder(personal, shared).doesNotContain(hidden);
        assertThat(store.listSessions(tenant + "other", "owner", null, null, 10).sessions()).isEmpty();
    }

    @Test
    void childrenInheritPrivateOwnershipWithoutMemoryAccess() {
        String memory = memory("owner");
        String parent = workspaceSession("owner", "workspace-a", memory);
        jdbc.update("UPDATE ma_session SET creator_actor_key=? WHERE tenant_id=? AND session_id=?",
                actorKey("other"), tenant, parent);
        String child = transaction.execute(status -> store.insertChildSessionCommand(tenant, parent,
                "child", "child-digest", "child", List.of(), null,
                new StoreModels.SessionLineage(parent, parent, "run-child", 1))).sessionId();
        var childRecord = store.requireSession(tenant, child);
        assertThat(childRecord.ownerOnly()).isTrue();
        assertThat(childRecord.memoryStoreId()).isNull();
        assertThat(workspaces.isSessionOwner(tenant, "owner", child)).isTrue();
        assertThat(childRecord.withStatus("CLOSED").ownerOnly()).isTrue();
        assertThat(store.requireSession(tenant, parent).withStatus("CLOSED").memoryStoreId()).isEqualTo(memory);
        notFound(() -> service.requireReadableSession(tenant, "other", child));
    }

    @Test
    void automationReadsAndListsRespectThePrivateSessionOwner() {
        String personal = workspaceSession("owner", "workspace-a", memory("owner"));
        String shared = workspaceSession("owner", "workspace-a", null);
        String privateSchedule = schedule(personal);
        String sharedSchedule = schedule(shared);
        var ledger = new JdbcAutomationLedgerStore(jdbc);
        var automations = new com.alibaba.qwen.code.managedagent.automation.ManagedAutomationService(
                ledger, store, workspaces, harness, null, new RequestDigests(), new ObjectMapper(), new ManagedAgentProperties());
        assertThat(automations.get(tenant, "owner", privateSchedule).goal()).isEqualTo("private synthetic context");
        assertThatThrownBy(() -> automations.get(tenant, "other", privateSchedule))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("automation_not_found"));
        assertThat(ledger.listReadableSchedules(tenant, "other", null, 10).rows())
                .extracting(row -> row.scheduleId()).containsExactly(sharedSchedule);
        assertThat(ledger.listReadableSchedules(tenant, "owner", null, 10).rows()).hasSize(2);
    }

    private String schedule(String session) {
        String id = "asch_" + UUID.randomUUID().toString().replace("-", "");
        jdbc.update("INSERT INTO ma_schedule (tenant_id,schedule_id,session_id,workspace_id,actor_id,record_revision,"
                        + "definition_revision,definition_digest,goal,cron,timezone,session_mode,overlap,catch_up,is_enabled,state,"
                        + "armed_at,gmt_create,gmt_modified) VALUES (?,?,?,'workspace-a',?,1,1,?,?,'0 * * * *','UTC','reuse','skip','skip',1,'armed',1,1,1)",
                tenant, id, session, actorKey("owner"), "a".repeat(64), "private synthetic context");
        return id;
    }

    private String workspaceSession(String actor, String workspace, String memory) {
        return transaction.execute(status -> store.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                .tenantId(tenant).actorId(actor).idempotencyKey(UUID.randomUUID().toString()).requestDigest("digest")
                .agentId("qwen-code").selection(new WorkspaceSelection(workspace, ".")).memoryStoreId(memory).build()))
                .sessionId();
    }

    private String memory(String actor) {
        String id = "memstore_" + UUID.randomUUID();
        jdbc.update("INSERT INTO ma_memory_store (store_key,owner_key,tenant_id,memory_store_id,owner_actor_key,namespace,gmt_create)"
                        + " VALUES (?,?,?,?,?,?,1)", ManagedSchemaKeys.key(tenant, id), ManagedSchemaKeys.key(tenant, actor),
                tenant, id, actorKey(actor), "memory-namespace-" + UUID.randomUUID());
        return id;
    }

    private byte[] actorKey(String actor) {
        return ManagedWorkspaceRegistry.actorKey(tenant, actor);
    }

    private int sessionCount() {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE tenant_id=?", Integer.class, tenant);
    }

    private static void notFound(ThrowingCallable operation) {
        assertThatThrownBy(operation).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
    }
}
