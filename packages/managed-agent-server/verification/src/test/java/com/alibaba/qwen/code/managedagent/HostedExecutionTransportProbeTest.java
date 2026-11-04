package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.InetSocketAddress;
import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@Timeout(10)
class HostedExecutionTransportProbeTest {
    @Test
    void cancellationProbeObservesExecutionAndCancellationAndRestoresBothOwners() throws Exception {
        try (var fixture = new Fixture()) {
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            var probe = new HostedCancellationProbe(mock(JdbcTemplate.class), "tenant", List.of(),
                    fixture.embedded, server);
            try {
                ToolExecutionRecord execution = fixture.execute("first");
                assertThat(execution.getState()).isEqualTo(ToolExecutionRecord.State.EXECUTING);
                assertThat(count(probe, "executions")).isEqualTo(1);
                assertThat(count(probe, "completions")).isZero();

                assertThat(fixture.service.cancelExecution("harness", "runtime", execution.getExecutionCallId())
                        .toCompletableFuture().join().getState()).isEqualTo(ToolExecutionRecord.State.CANCEL_REQUESTED);
                assertThat(count(probe, "cancellations")).isEqualTo(1);
                assertThat(count(probe, "completions")).isZero();
                fixture.answer.complete(Map.of("executionStatus", "cancelled"));
                assertThat(fixture.state(execution)).isEqualTo(ToolExecutionRecord.State.SETTLED);
                assertThat(count(probe, "completions")).isEqualTo(1);
            } finally {
                probe.close();
                server.stop(0);
            }

            fixture.answer = new CompletableFuture<>();
            ToolExecutionRecord afterClose = fixture.execute("after-close");
            fixture.service.cancelExecution("harness", "runtime", afterClose.getExecutionCallId())
                    .toCompletableFuture().join();
            fixture.answer.complete(Map.of("executionStatus", "cancelled"));
            assertThat(fixture.state(afterClose)).isEqualTo(ToolExecutionRecord.State.SETTLED);
            assertThat(count(probe, "executions")).isEqualTo(1);
            assertThat(count(probe, "cancellations")).isEqualTo(1);
            assertThat(count(probe, "completions")).isEqualTo(1);
        }
    }

    @Test
    void statusReplyLossGateHoldsSettlementUntilRelease() throws Exception {
        try (var fixture = new Fixture()) {
            var gate = new CompletableFuture<Void>();
            HostedWorkspaceToolTurnIT.holdExecutionResults(fixture.embedded, "harness", gate);
            ToolExecutionRecord execution = fixture.execute("held");
            fixture.answer.complete(Map.of("executionStatus", "success"));
            assertThat(gate.isDone()).isFalse();
            assertThat(fixture.state(execution)).isEqualTo(ToolExecutionRecord.State.EXECUTING);
            gate.complete(null);
            assertThat(fixture.state(execution)).isEqualTo(ToolExecutionRecord.State.SETTLED);
        }
    }

    @SuppressWarnings("unchecked")
    private static int count(HostedCancellationProbe probe, String field) {
        var counts = (Map<String, AtomicInteger>) ReflectionTestUtils.getField(probe, field);
        AtomicInteger value = counts.get("harness");
        return value == null ? 0 : value.get();
    }

    private static final class Fixture implements AutoCloseable {
        private final RuntimeTransport transport = mock(RuntimeTransport.class);
        private final EmbeddedRuntimeBroker embedded = mock(EmbeddedRuntimeBroker.class);
        private final RuntimeBrokerService service;
        private CompletableFuture<Map<String, Object>> answer = new CompletableFuture<>();

        private Fixture() {
            RuntimeScope scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "capability", "workspace");
            when(transport.acquire(any(), any())).thenReturn(CompletableFuture.completedFuture(null));
            when(transport.reclaimMount(any(), any())).thenReturn(CompletableFuture.completedFuture(null));
            when(transport.execute(any(), any(), any())).thenAnswer(ignored -> answer);
            when(transport.cancel(any(), any(), any()))
                    .thenReturn(CompletableFuture.completedFuture(Map.of("state", "cancel_requested")));
            service = new RuntimeBrokerService(ignored -> CompletableFuture.completedFuture(scope),
                    new Provisioner(), transport, new InMemoryRuntimeBindingRepository(),
                    new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            ReflectionTestUtils.setField(embedded, "service", service);
            service.acquire("harness", "runtime", "bootstrap").toCompletableFuture().join();
        }

        private ToolExecutionRecord execute(String key) {
            return service.createExecution("harness", "runtime", key,
                    Map.of("sessionId", "runtime", "promptId", "prompt", "callId", key, "argsDigest", "digest"))
                    .toCompletableFuture().join();
        }

        private ToolExecutionRecord.State state(ToolExecutionRecord execution) {
            return service.getExecution("harness", "runtime", execution.getExecutionCallId())
                    .toCompletableFuture().join().getState();
        }

        @Override
        public void close() {
            service.close();
        }
    }

    private static final class Provisioner implements RuntimeProvisioner {
        private final OwnedProcesses delegate = new OwnedProcesses(Map.of());

        @Override
        public CompletionStage<RuntimeLease> provision(RuntimeProvisionRequest request) {
            return CompletableFuture.completedFuture(new RuntimeLease("instance", URI.create("http://127.0.0.1:1234"),
                    "token", "lease", 1));
        }
    }

    private record OwnedProcesses(Map<String, Object> owned) {
    }
}
