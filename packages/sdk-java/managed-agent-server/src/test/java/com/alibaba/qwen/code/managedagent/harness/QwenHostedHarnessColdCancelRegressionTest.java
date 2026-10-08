package com.alibaba.qwen.code.managedagent.harness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilities;
import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.service.HarnessEventProjector;
import com.alibaba.qwen.code.managedagent.service.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.managedagent.store.ManagedActionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:cold-cancel;MODE=MySQL;"
                + "DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class QwenHostedHarnessColdCancelRegressionTest {
    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private ManagedWorkspaceRegistry registry;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    @Transactional
    void coldCancellationRequiresPersistedIntentAndSurvivesMutableAuthorityChanges() {
        String tenant = "tenant-" + UUID.randomUUID();
        String boot = "11111111-1111-4111-8111-111111111111";
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id,"
                        + " workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                        + " VALUES (?, 'ws-a', 1, 'storage-a', 'Workspace', ?, ?, 'ACTIVE')",
                tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                        + " VALUES (?, 'ws-a', ?, TRUE, TRUE)",
                tenant, "actor-a".getBytes(StandardCharsets.UTF_8));
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setToken("test-token");
        properties.getHarness().setCapabilityDigest("sha256:" + "a".repeat(64));
        ManagedAgentStore store = new ManagedAgentStore(jdbc, mapper, Clock.systemUTC(),
                ignored -> { }, registry, properties);
        var admission = store.insertWorkspaceSessionCommand(tenant, "actor-a", "create", "digest",
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("ws-a", "."));
        String session = admission.sessionId();
        String turn = store.insertTurnCommand(tenant, "SUBMIT", "submit", "digest", session,
                List.of(Map.of("type", "text", "text", "go")), "payload").turnId();
        assertThat(turn).isNotNull();

        HostedHarnessClient client = mock(HostedHarnessClient.class);
        HostedHarnessCapabilities capabilities = mock(HostedHarnessCapabilities.class);
        HarnessSessionRef attached = mock(HarnessSessionRef.class);
        when(client.capabilities()).thenReturn(capabilities);
        when(capabilities.getBootId()).thenReturn(boot);
        when(client.loadSession(any())).thenReturn(attached);
        when(attached.getHarnessBootId()).thenReturn(boot);
        when(attached.getApprovalMode()).thenReturn("yolo");
        HarnessRuntimeRecovery recovery = mock(HarnessRuntimeRecovery.class);
        when(recovery.getCheckpointId()).thenReturn("checkpoint-of-T1");
        when(attached.getRuntimeRecovery()).thenReturn(recovery);
        ManagedActionStore actions = mock(ManagedActionStore.class);
        when(actions.approvalMode(tenant, session)).thenReturn("yolo");
        WorkspaceExecutionStore execution = new WorkspaceExecutionStore(jdbc, transactionManager);
        QwenHostedHarnessConnector connector = new QwenHostedHarnessConnector(properties, store, execution, actions);
        ReflectionTestUtils.setField(connector, "client", client);
        connector.createOrLoad(tenant, session, true);

        ExecutorService executor = mock(ExecutorService.class);
        doAnswer(invocation -> {
            invocation.<Runnable>getArgument(0).run();
            return null;
        }).when(executor).execute(any(Runnable.class));
        HarnessCoordinator coordinator = new HarnessCoordinator(store, connector,
                new HarnessEventProjector(), null, executor, Clock.systemUTC(), properties) {
            @Override
            public void dispatch(String tenantId, String sessionId, String turnId) {
            }
        };
        try {
            String owner = (String) ReflectionTestUtils.getField(coordinator, "owner");
            assertThat(store.claimTurn(tenant, session, turn, owner, Duration.ofMinutes(1))).isPresent();
            assertThat(store.bindHarness(tenant, session, turn, owner, boot)).isTrue();
            store.markSubmissionAttempted(tenant, session, turn, owner);
            store.recordAdmission(tenant, session, turn, owner, "epoch", 1);
            assertThatThrownBy(() -> connector.recoverManagedRuntime(tenant, session, true))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class,
                            error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
            jdbc.update("UPDATE managed_workspace_access SET can_create = FALSE WHERE tenant_id = ?", tenant);
            assertThat(store.insertCancelCommand(tenant, "CANCEL", "cancel", "digest", session, turn)
                    .commandEffect()).isTrue();

            coordinator.cancel(tenant, session, turn);
            verify(client).cancelTurn(attached);
            clearInvocations(client);
            ((Map<?, ?>) ReflectionTestUtils.getField(connector, "attachments")).clear();

            doThrow(new IllegalStateException("temporary cancel failure"))
                    .when(client).cancelTurn(attached);
            assertThatThrownBy(() -> connector.cancel(tenant, session))
                    .isInstanceOf(IllegalStateException.class);
            assertThat(connector.recoverManagedRuntime(tenant, session, true).runtimeRecovery())
                    .isSameAs(recovery);
            clearInvocations(client);
            doNothing().when(client).cancelTurn(attached);
            coordinator.cancel(tenant, session, turn);
            jdbc.update("UPDATE managed_workspace_access SET can_create = TRUE WHERE tenant_id = ?", tenant);
            assertThat(connector.recoverManagedRuntime(tenant, session, false).runtimeRecovery()).isNull();
            jdbc.update("UPDATE managed_workspace_access SET can_create = FALSE WHERE tenant_id = ?", tenant);

            assertThat(store.findTurn(tenant, session, turn).orElseThrow().status()).isEqualTo("CANCELLING");
            verify(client).cancelTurn(attached);
            assertThat(execution.verifiedRecoveryEnabled()).isFalse();
            assertThatThrownBy(() -> connector.submit(tenant, session, "later", List.of(), "digest"))
                    .isInstanceOf(RuntimeBrokerException.class);
            verify(client, never()).submitTurn(any());

            for (String change : List.of(
                    "UPDATE managed_workspace_access SET can_read = FALSE WHERE tenant_id = ?",
                    "UPDATE managed_workspace_registry SET state = 'DRAINING' WHERE tenant_id = ?",
                    "UPDATE managed_workspace_registry SET workspace_generation = workspace_generation + 1 WHERE tenant_id = ?",
                    "UPDATE managed_workspace_registry SET storage_id = 'replacement-storage' WHERE tenant_id = ?")) {
                jdbc.update(change, tenant);
                clearInvocations(client);
                ((Map<?, ?>) ReflectionTestUtils.getField(connector, "attachments")).clear();
                coordinator.cancel(tenant, session, turn);
                verify(client).cancelTurn(attached);
            }

            ManagedAgentService service = new ManagedAgentService(store, new RequestDigests(),
                    coordinator, connector, registry);
            clearInvocations(client);
            assertThatThrownBy(() -> service.cancelTurn(tenant, "actor-a", "cancel-fresh", session, turn))
                    .isInstanceOfSatisfying(ApiException.class,
                            error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
            assertThat(store.findCommand(tenant, "CANCEL", "cancel-fresh")).isEmpty();
        } finally {
            coordinator.close();
            connector.close();
        }
    }
}
