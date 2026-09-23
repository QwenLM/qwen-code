package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;

class LocalProcessRuntimeProvisionerTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void adoptsAWorkerOnlyAfterAttestationAndRejectsToolRoutes()
            throws Exception {
        assumeTrue(commandExists("node"), "node is required");
        Path script = Path.of("src/test/resources/fake-attestation-worker.mjs")
                .toAbsolutePath();
        assumeTrue(Files.isRegularFile(script));
        RuntimeScope scope = new RuntimeScope("tenant-a", "workspace-a", "7",
                "/runtime/workspace", DIGEST, "workspace");
        HttpRuntimeTransport transport = new HttpRuntimeTransport();
        try (LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        List.of("node", script.toString()),
                        Path.of("").toAbsolutePath(), transport)) {
            InMemoryRuntimeBindingRepository bindings =
                    new InMemoryRuntimeBindingRepository(
                            java.time.Clock.systemUTC(), () -> "binding-1");
            RuntimeBrokerService service = new RuntimeBrokerService(
                    harnessSessionId -> java.util.concurrent.CompletableFuture
                            .completedFuture(scope),
                    provisioner, new AcceptingTransport(), bindings,
                    new InMemoryRuntimeSessionRepository(),
                    new InMemoryToolExecutionRepository(
                            java.time.Clock.systemUTC()),
                    "broker", Duration.ofMinutes(1), Duration.ofMinutes(1));
            try {
                RuntimeBindingRecord ready = service.warm("harness")
                        .toCompletableFuture().get(30, TimeUnit.SECONDS);
                assertEquals(RuntimeBindingRecord.State.READY,
                        ready.getState());
                RuntimeLease lease = ready.getLease();
                ExecutionException failure = org.junit.jupiter.api.Assertions
                        .assertThrows(ExecutionException.class,
                                () -> transport.execute(lease,
                                        new RuntimeSession("harness",
                                                "runtime", "bootstrap", scope),
                                        java.util.Map.of("callId", "tool-1"))
                                        .toCompletableFuture()
                                        .get(10, TimeUnit.SECONDS));
                Throwable cause = failure.getCause();
                assertTrue(cause instanceof RuntimeBrokerException);
                RuntimeBrokerException rejected =
                        (RuntimeBrokerException) cause;
                assertEquals(404, rejected.getStatusCode());
                assertEquals("managed_runtime_incompatible",
                        rejected.getCode());
                assertFalse(rejected.isRetryable());

                provisioner.stop(lease);
                ExecutionException again = org.junit.jupiter.api.Assertions
                        .assertThrows(ExecutionException.class,
                                () -> service.warm("harness")
                                        .toCompletableFuture()
                                        .get(10, TimeUnit.SECONDS));
                assertTrue(again.getCause() instanceof RuntimeBrokerException);
            } finally {
                service.close();
            }
        }
    }

    private static boolean commandExists(String command) {
        try {
            return new ProcessBuilder(command, "-v")
                    .redirectErrorStream(true)
                    .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                    .start().waitFor(2, TimeUnit.SECONDS);
        } catch (Exception exception) {
            return false;
        }
    }

    private static final class AcceptingTransport implements RuntimeTransport {
        @Override
        public java.util.concurrent.CompletionStage<Void> acquire(
                RuntimeLease lease, RuntimeSession session) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    null);
        }

        @Override
        public java.util.concurrent.CompletionStage<Object> control(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> operation) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    "ok");
        }

        @Override
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> reference) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    java.util.Map.of("executionStatus", "success"));
        }

        @Override
        public java.util.concurrent.CompletionStage<java.util.Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                java.util.Map<String, Object> reference) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    java.util.Map.of("state", "settled"));
        }

        @Override
        public java.util.concurrent.CompletionStage<Boolean> release(
                RuntimeLease lease, RuntimeSession session) {
            return java.util.concurrent.CompletableFuture.completedFuture(
                    true);
        }
    }
}
