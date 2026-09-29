package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.*;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.*;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.io.TempDir;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest(properties = {
        "spring.datasource.url=jdbc:h2:mem:workspace-recovery-worker;MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE",
        "spring.datasource.driver-class-name=org.h2.Driver", "spring.datasource.username=sa", "spring.datasource.password=",
        "qwen.managed-agent.harness.enabled=false"
})
class HostedWorkspaceRecoveryWorkerIT {
    @Autowired private DataSource source;
    @Autowired private JdbcTemplate jdbc;
    @Autowired private ManagedAgentStore store;
    @Autowired private WorkspaceExecutionStore authority;

    @TempDir private Path temporary;

    @Test
    void realWorkerAndSpringSqlRecoverSavedHolderAfterSyntheticReboot() throws Exception {
        Path bundle = Path.of(System.getProperty("qwen.runtime.worker.bundle", "../../../dist/cli.js"))
                .toAbsolutePath().normalize();
        assertThat(bundle).isRegularFile();
        temporary = temporary.toRealPath();
        Path workspace = Files.createDirectory(temporary.resolve("workspace"));
        Path state = temporary.resolve("state");
        var fixture = new WorkspaceRecoveryContract.Fixture(source, jdbc, store);
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                fixture.tenant, "storage", workspace.toString())));
        var resolver = new WorkspaceRuntimeResolver(store, authority, properties);
        var http = new HttpRuntimeTransport();
        RuntimeBindingRecord original;
        RuntimeRecoveryEvidence firstLoss;
        RuntimeSessionRecord runtimeSession;
        ProcessHandle worker = null;
        try {
            try (var local = LocalRebootTestSupport.provisioner(List.of("node", bundle.toString(), "managed-runtime-worker"),
                    state, http, false);
                    var broker = new RuntimeBrokerService(id -> CompletableFuture.completedFuture(resolver.resolve(id).scope()),
                            new WorkspaceRuntimeProvisioner(local, resolver, authority),
                            new WorkspaceRuntimeTransport(http, resolver, authority, fixture.bindings, fixture.sessions),
                            fixture.bindings, fixture.sessions, fixture.executions, "first", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
                runtimeSession = broker.acquire(fixture.session.sessionId(), fixture.tenant + "-runtime", "bootstrap")
                        .toCompletableFuture().get(10, TimeUnit.SECONDS);
                original = fixture.bindings.findById(runtimeSession.getBindingId());
                String key = original.getResourceHandle().getValue().get("resourceId").toString();
                long pid = new com.fasterxml.jackson.databind.ObjectMapper().readTree(state.resolve(key + ".json").toFile())
                        .get("pid").asLong();
                worker = ProcessHandle.of(pid).orElseThrow();
                authority.assertHeld(fixture.session.workspace(), runtimeSession);
                var receipt = broker.prepareExecution(fixture.session.sessionId(), runtimeSession.getRuntimeSessionId(),
                        fixture.tenant + "-call", Map.of("sessionId", runtimeSession.getRuntimeSessionId(), "promptId", "turn",
                                "callId", "call", "argsDigest", "sha256:" + "a".repeat(64)))
                        .toCompletableFuture().get(5, TimeUnit.SECONDS);
                worker.destroyForcibly();
                worker.onExit().get(5, TimeUnit.SECONDS);
                var pinned = broker.recoverBinding(original.getBindingId(), original.getGeneration()).toCompletableFuture()
                        .get(10, TimeUnit.SECONDS);
                assertThat(pinned.getState()).isEqualTo(RuntimeBindingRecord.State.LOST);
                firstLoss = pinned.getLossEvidence();
                assertThat(pinned.getStopEvidence()).isNull();
                authority.assertHeld(fixture.session.workspace(), runtimeSession);
                assertThat(fixture.executions.findByExecutionCallId(receipt.getExecutionCallId()).getState())
                        .isEqualTo(ToolExecutionRecord.State.ABANDONED);
            }
            jdbc.update("DELETE FROM managed_workspace_access WHERE tenant_id = ?", fixture.tenant);
            jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 2 WHERE session_id = ?",
                    fixture.session.sessionId());
            jdbc.update("UPDATE managed_workspace_registry SET storage_id = 'changed', state = 'REMOVED' WHERE tenant_id = ?",
                    fixture.tenant);
            var noMounts = new WorkspaceRuntimeResolver(store, authority, new ManagedAgentProperties());
            try (var local = LocalRebootTestSupport.provisioner(List.of("must-not-run"), state, http, true);
                    var restored = new RuntimeBrokerService(id -> { throw new AssertionError("Current authorization was consulted"); },
                            new WorkspaceRuntimeProvisioner(local, noMounts, authority),
                            new WorkspaceRuntimeTransport(http, noMounts, authority, fixture.bindings, fixture.sessions),
                            fixture.bindings, fixture.sessions, fixture.executions, "restored", Duration.ofSeconds(10), Duration.ofSeconds(10))) {
                var released = restored.recoverBinding(original.getBindingId(), original.getGeneration()).toCompletableFuture()
                        .get(10, TimeUnit.SECONDS);
                assertThat(released.getState()).isEqualTo(RuntimeBindingRecord.State.RELEASED);
                assertThat(released.getLossEvidence()).isEqualTo(firstLoss);
                assertThat(released.getStopEvidence().source()).isEqualTo("trusted-host-reboot");
                assertThat(fixture.sessions.countActiveByBinding(original.getBindingId(), original.getGeneration())).isZero();
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease WHERE binding_id = ?",
                        Long.class, original.getBindingId())).isZero();
                assertThat(fixture.bindings.findActive(original.getRequest())).isNull();
                assertThat(worker.isAlive()).isFalse();
                try (var records = Files.list(state)) {
                    assertThat(records.filter(path -> path.toString().endsWith(".json")).count()).isEqualTo(1);
                }
            }
        } finally {
            if (worker != null && worker.isAlive()) {
                worker.destroyForcibly();
                worker.onExit().get(5, TimeUnit.SECONDS);
            }
        }
    }
}
