package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

@Tag("managed-hosted-integration")
@EnabledIfEnvironmentVariable(named = "QWEN_MANAGED_HOSTED_E2E_BASE_URL",
        matches = ".+")
class ManagedHostedRuntimeE2ETest {
    @Test
    void firstModelEventPrecedesColdRuntimeAndSameTurnContinues()
            throws Exception {
        String workspace = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_WORKSPACE");
        String firstChunk = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_FIRST_CHUNK");
        String finalText = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_FINAL_TEXT");
        long expectedDelayMillis = Long.parseLong(requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_DELAY_MS"));

        try (HostedHarnessClient harness = newHarnessClient();
                HostedSession session = createSession(harness,
                        workspace)) {
            startWarmup(session.getSessionId());
            long promptStartedAt = System.currentTimeMillis();
            AtomicLong firstModelEventAt = new AtomicLong(-1);
            AtomicLong firstToolEventAt = new AtomicLong(-1);
            AtomicInteger tools = new AtomicInteger();
            StringBuilder text = new StringBuilder();
            PromptCall call = session.startPrompt(PromptRequest.text(
                    "Write the requested file and finish the same turn."),
                    new PromptObserver() {
                        @Override
                        public void onText(String chunk, DaemonEvent event) {
                            text.append(chunk);
                            firstModelEventAt.compareAndSet(-1,
                                    System.currentTimeMillis());
                        }

                        @Override
                        public void onTool(Map<String, Object> update,
                                DaemonEvent event) {
                            tools.incrementAndGet();
                            firstToolEventAt.compareAndSet(-1,
                                    System.currentTimeMillis());
                        }
                    });

            call.acceptanceFuture().get(5, TimeUnit.SECONDS);
            long promptAcceptedAt = System.currentTimeMillis();
            PromptTerminal terminal = call.completionFuture()
                    .get(90, TimeUnit.SECONDS);
            Map<String, Object> status = brokerStatus();
            long provisionStartedAt = JsonSupport.requiredNonNegativeLong(
                    status, "provisionStartedAtEpochMillis", "fixture status");
            long runtimeReadyAt = JsonSupport.requiredNonNegativeLong(status,
                    "runtimeReadyAtEpochMillis", "fixture status");
            long firstAt = firstModelEventAt.get();
            long firstToolAt = firstToolEventAt.get();
            long completedAt = System.currentTimeMillis();

            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
            assertTrue(text.toString().contains(firstChunk));
            assertTrue(text.toString().contains(finalText));
            assertTrue(tools.get() > 0);
            assertTrue(firstAt >= promptStartedAt);
            assertTrue(firstToolAt >= firstAt);
            assertTrue(firstAt < runtimeReadyAt,
                    "first model event must precede Runtime readiness");
            assertTrue(firstToolAt < runtimeReadyAt,
                    "tool request must wait on the cold Runtime binding");
            assertTrue(firstAt - promptStartedAt < 5_000,
                    "first model event must stay off the Runtime cold path");
            assertTrue(runtimeReadyAt - provisionStartedAt
                    >= expectedDelayMillis - 250);
            assertEquals(1, JsonSupport.requiredInt(status,
                    "provisionCount", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(status,
                    "warmRequests", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(status,
                    "physicalAcquireCount", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(status,
                    "physicalExecutionCount", "fixture status"));
            assertEquals("written after cold Runtime readiness",
                    Files.readString(Path.of(workspace, "managed-e2e.txt"),
                            StandardCharsets.UTF_8));
            System.out.println("MANAGED_HOSTED_E2E_METRICS "
                    + JsonSupport.encode(Map.of(
                            "first_model_event_ms",
                            firstAt - promptStartedAt,
                            "prompt_accepted_ms",
                            promptAcceptedAt - promptStartedAt,
                            "runtime_ready_ms",
                            runtimeReadyAt - promptStartedAt,
                            "runtime_provision_ms",
                            runtimeReadyAt - provisionStartedAt,
                            "tool_wait_runtime_ms",
                            Math.max(0, runtimeReadyAt - firstToolAt),
                            "turn_completed_ms",
                            completedAt - promptStartedAt,
                            "physical_execute_count", 1)));
        }
    }

    @Test
    void cancellationBeforeRuntimeReadinessHasNoPhysicalSideEffect()
            throws Exception {
        String workspace = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_WORKSPACE");
        String firstChunk = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_FIRST_CHUNK");
        CountDownLatch toolRequested = new CountDownLatch(1);
        AtomicLong firstModelEventAt = new AtomicLong(-1);

        try (HostedHarnessClient harness = newHarnessClient();
                HostedSession session = createSession(harness,
                        workspace)) {
            startWarmup(session.getSessionId());
            long promptStartedAt = System.currentTimeMillis();
            PromptCall call = session.startPrompt(PromptRequest.text(
                    "Request the file write, then wait for cancellation."),
                    new PromptObserver() {
                        @Override
                        public void onText(String chunk, DaemonEvent event) {
                            if (chunk.contains(firstChunk)) {
                                firstModelEventAt.compareAndSet(-1,
                                        System.currentTimeMillis());
                            }
                        }

                        @Override
                        public void onTool(Map<String, Object> update,
                                DaemonEvent event) {
                            toolRequested.countDown();
                        }
                    });

            call.acceptanceFuture().get(5, TimeUnit.SECONDS);
            assertTrue(toolRequested.await(5, TimeUnit.SECONDS));
            Map<String, Object> beforeCancel = brokerStatus();
            assertEquals(-1, requiredLong(beforeCancel,
                    "runtimeReadyAtEpochMillis"));
            long cancelledAt = System.currentTimeMillis();
            session.cancelActivePrompt();

            PromptTerminal terminal = call.completionFuture()
                    .get(30, TimeUnit.SECONDS);
            assertCancelled(terminal);
            Map<String, Object> settled = waitForRuntimeAcquired();
            Thread.sleep(500);
            settled = brokerStatus();
            long runtimeReadyAt = requiredLong(settled,
                    "runtimeReadyAtEpochMillis");

            assertTrue(firstModelEventAt.get() >= promptStartedAt);
            assertTrue(cancelledAt < runtimeReadyAt);
            assertEquals(1, JsonSupport.requiredInt(settled,
                    "provisionCount", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(settled,
                    "warmRequests", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(settled,
                    "physicalAcquireCount", "fixture status"));
            assertEquals(0, JsonSupport.requiredInt(settled,
                    "physicalExecutionCount", "fixture status"));
            assertFalse(Files.exists(Path.of(workspace,
                    "managed-e2e.txt")));
            System.out.println("MANAGED_HOSTED_CANCEL_E2E_METRICS "
                    + JsonSupport.encode(Map.of(
                            "first_model_event_ms",
                            firstModelEventAt.get() - promptStartedAt,
                            "cancel_requested_ms",
                            cancelledAt - promptStartedAt,
                            "runtime_ready_ms",
                            runtimeReadyAt - promptStartedAt,
                            "physical_execute_count", 0)));
        }
    }

    @Test
    void cancellationAfterPhysicalStartStopsProcessTree() throws Exception {
        String workspace = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_WORKSPACE");
        Path startedPath = Path.of(requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_ACTIVE_CANCEL_STARTED"));
        Path delayedPath = Path.of(requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_ACTIVE_CANCEL_DELAYED"));
        CountDownLatch toolRequested = new CountDownLatch(1);

        try (HostedHarnessClient harness = newHarnessClient();
                HostedSession session = createSession(harness,
                        workspace)) {
            startWarmup(session.getSessionId());
            long promptStartedAt = System.currentTimeMillis();
            PromptCall call = session.startPrompt(PromptRequest.text(
                    "Run the long process tree and wait for cancellation."),
                    new PromptObserver() {
                        @Override
                        public void onTool(Map<String, Object> update,
                                DaemonEvent event) {
                            toolRequested.countDown();
                        }
                    });

            call.acceptanceFuture().get(5, TimeUnit.SECONDS);
            assertTrue(toolRequested.await(10, TimeUnit.SECONDS));
            waitForFile(startedPath, Duration.ofSeconds(30));
            Map<String, Object> running = waitForCount(
                    "physicalExecutionCount", 1, Duration.ofSeconds(10));
            Map<String, Object> processIds = JsonSupport.parseObject(
                    Files.readString(startedPath, StandardCharsets.UTF_8),
                    "active cancellation process ids");
            long rootPid = requiredLong(processIds, "rootPid");
            long childPid = requiredLong(processIds, "childPid");
            long startedAt = requiredLong(processIds,
                    "startedAtEpochMillis");
            assertTrue(isProcessAlive(rootPid));
            assertTrue(isProcessAlive(childPid));

            long cancelledAt = System.currentTimeMillis();
            session.cancelActivePrompt();
            assertCancelled(call.completionFuture()
                    .get(30, TimeUnit.SECONDS));
            Map<String, Object> cancelled = waitForCount(
                    "physicalCancelCount", 1, Duration.ofSeconds(15));
            waitForProcessExit(rootPid, Duration.ofSeconds(10));
            waitForProcessExit(childPid, Duration.ofSeconds(10));
            waitUntil(startedAt + 5_000);

            assertEquals(1, JsonSupport.requiredInt(running,
                    "physicalExecutionCount", "fixture status"));
            assertEquals(1, JsonSupport.requiredInt(cancelled,
                    "physicalCancelCount", "fixture status"));
            assertFalse(isProcessAlive(rootPid));
            assertFalse(isProcessAlive(childPid));
            assertFalse(Files.exists(delayedPath));
            System.out.println("MANAGED_HOSTED_ACTIVE_CANCEL_E2E_METRICS "
                    + JsonSupport.encode(Map.of(
                            "execution_started_ms",
                            startedAt - promptStartedAt,
                            "cancel_requested_ms",
                            cancelledAt - promptStartedAt,
                            "physical_execute_count", 1,
                            "physical_cancel_count", 1)));
        }
    }

    @Test
    void twoHostedSessionsStayIsolated() throws Exception {
        String workspace = requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_WORKSPACE");
        StringBuilder alphaText = new StringBuilder();
        StringBuilder betaText = new StringBuilder();
        StringBuilder alphaToolUpdates = new StringBuilder();
        StringBuilder betaToolUpdates = new StringBuilder();
        AtomicInteger alphaTools = new AtomicInteger();
        AtomicInteger betaTools = new AtomicInteger();

        try (HostedHarnessClient harness = newHarnessClient();
                HostedSession alpha = createSession(harness, workspace);
                HostedSession beta = createSession(harness, workspace)) {
            startWarmup(alpha.getSessionId());
            startWarmup(beta.getSessionId());
            PromptCall alphaCall = alpha.startPrompt(PromptRequest.text(
                    "managed-session-alpha: write the alpha file."),
                    collectingObserver(alphaText, alphaToolUpdates,
                            alphaTools));
            PromptCall betaCall = beta.startPrompt(PromptRequest.text(
                    "managed-session-beta: write the beta file."),
                    collectingObserver(betaText, betaToolUpdates,
                            betaTools));

            alphaCall.acceptanceFuture().get(5, TimeUnit.SECONDS);
            betaCall.acceptanceFuture().get(5, TimeUnit.SECONDS);
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    alphaCall.completionFuture().get(30, TimeUnit.SECONDS)
                            .getKind());
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    betaCall.completionFuture().get(30, TimeUnit.SECONDS)
                            .getKind());
            Map<String, Object> status = waitForCount(
                    "physicalExecutionCount", 2, Duration.ofSeconds(10));

            assertTrue(alphaText.toString().contains(
                    "managed session alpha complete"));
            assertFalse(alphaText.toString().contains("beta"));
            assertTrue(betaText.toString().contains(
                    "managed session beta complete"));
            assertFalse(betaText.toString().contains("alpha"));
            assertTrue(alphaTools.get() > 0);
            assertTrue(betaTools.get() > 0);
            assertTrue(alphaToolUpdates.toString().contains("alpha.txt"));
            assertFalse(alphaToolUpdates.toString().contains("beta.txt"));
            assertTrue(betaToolUpdates.toString().contains("beta.txt"));
            assertFalse(betaToolUpdates.toString().contains("alpha.txt"));
            assertEquals("alpha isolated content", Files.readString(
                    Path.of(workspace, "alpha.txt"), StandardCharsets.UTF_8));
            assertEquals("beta isolated content", Files.readString(
                    Path.of(workspace, "beta.txt"), StandardCharsets.UTF_8));
            assertEquals(1, JsonSupport.requiredInt(status,
                    "provisionCount", "fixture status"));
            assertEquals(2, JsonSupport.requiredInt(status,
                    "warmRequests", "fixture status"));
            assertEquals(2, JsonSupport.requiredInt(status,
                    "physicalAcquireCount", "fixture status"));
            assertEquals(2, JsonSupport.requiredInt(status,
                    "physicalExecutionCount", "fixture status"));
            List<?> acquired = requiredList(status,
                    "acquiredHarnessSessionIds");
            List<?> executed = requiredList(status,
                    "executedHarnessSessionIds");
            assertTrue(acquired.contains(alpha.getSessionId()));
            assertTrue(acquired.contains(beta.getSessionId()));
            assertTrue(executed.contains(alpha.getSessionId()));
            assertTrue(executed.contains(beta.getSessionId()));
            System.out.println("MANAGED_HOSTED_ISOLATION_E2E_METRICS "
                    + JsonSupport.encode(Map.of(
                            "logical_session_count", 2,
                            "physical_provision_count", 1,
                            "physical_acquire_count", 2,
                            "physical_execute_count", 2)));
        }
    }

    private static HostedHarnessClient newHarnessClient() {
        return HostedHarnessClient.builder()
                .baseUri(URI.create(requiredEnvironment(
                        "QWEN_MANAGED_HOSTED_E2E_BASE_URL")))
                .bearerToken(requiredEnvironment(
                        "QWEN_MANAGED_HOSTED_E2E_TOKEN"))
                .capabilityDigest(requiredEnvironment(
                        "QWEN_MANAGED_HOSTED_E2E_CAPABILITY_DIGEST"))
                .heartbeatInterval(Duration.ZERO)
                .build();
    }

    private static HostedSession createSession(HostedHarnessClient harness,
            String workspace) throws Exception {
        HarnessSessionRef session = harness.createSession(
                CreateHarnessSession.builder()
                .harnessSessionId(UUID.randomUUID().toString())
                .approvalMode(DaemonApprovalMode.YOLO)
                .build());
        assertEquals(Path.of(workspace).toRealPath(),
                Path.of(session.getHarnessControlCwd()).toRealPath());
        return new HostedSession(harness, session);
    }

    private static final class HostedSession implements AutoCloseable {
        private final HostedHarnessClient harness;
        private final HarnessSessionRef session;

        private HostedSession(HostedHarnessClient harness,
                HarnessSessionRef session) {
            this.harness = harness;
            this.session = session;
        }

        private String getSessionId() {
            return session.getHarnessSessionId();
        }

        private PromptCall startPrompt(PromptRequest request,
                PromptObserver observer) {
            String promptId = UUID.randomUUID().toString();
            SubmitHarnessTurn.Builder submit = SubmitHarnessTurn.builder()
                    .session(session)
                    .promptId(promptId)
                    .payloadDigest(SubmitHarnessTurn.computePayloadDigest(
                            request.getContent()));
            request.getContent().forEach(submit::addContent);
            if (request.getDeadlineMillis() != null) {
                submit.deadline(Duration.ofMillis(
                        request.getDeadlineMillis()));
            }
            PromptReceipt receipt = harness.submitTurn(submit.build());
            CompletableFuture<PromptTerminal> completion =
                    CompletableFuture.supplyAsync(
                            () -> observe(receipt, observer),
                            ForkJoinPool.commonPool());
            return new PromptCall(
                    CompletableFuture.completedFuture(new PromptAcceptance(
                            receipt.getPromptId(), receipt.getLastEventId(),
                            receipt.getEventEpoch())),
                    completion, ForkJoinPool.commonPool(),
                    new CountDownLatch(0));
        }

        private PromptTerminal observe(PromptReceipt receipt,
                PromptObserver observer) {
            try (HarnessEventStream stream = harness.streamEvents(
                    StreamHarnessEvents.builder()
                            .session(session)
                            .lastEventId(receipt.getLastEventId())
                            .eventEpoch(receipt.getEventEpoch())
                            .build())) {
                for (DaemonEvent event = stream.next(); event != null;
                        event = stream.next()) {
                    if (!event.belongsTo(receipt.getPromptId())) {
                        continue;
                    }
                    if ("turn_complete".equals(event.getType())
                            || "turn_error".equals(event.getType())) {
                        return PromptTerminal.from(event,
                                receipt.getPromptId(), getSessionId());
                    }
                    dispatch(observer, event, getSessionId());
                }
            }
            throw new DaemonProtocolException(
                    "Hosted Harness stream ended before terminal");
        }

        private void cancelActivePrompt() {
            harness.cancelTurn(session);
        }

        @Override
        public void close() {
            harness.detachSession(session);
        }
    }

    private static void dispatch(PromptObserver observer, DaemonEvent event,
            String sessionId) {
        if (!"session_update".equals(event.getType())) {
            observer.onEvent(event);
            return;
        }
        event.requireSessionId(sessionId, "session_update");
        String kind = event.updateKind();
        if ("agent_message_chunk".equals(kind)) {
            String text = event.textChunk();
            if (text != null) {
                observer.onText(text, event);
            }
        } else if ("tool_call".equals(kind)
                || "tool_call_update".equals(kind)) {
            observer.onTool(event.update(), event);
        }
        observer.onEvent(event);
    }

    private static PromptObserver collectingObserver(StringBuilder text,
            StringBuilder toolUpdates, AtomicInteger tools) {
        return new PromptObserver() {
            @Override
            public void onText(String chunk, DaemonEvent event) {
                text.append(chunk);
            }

            @Override
            public void onTool(Map<String, Object> update,
                    DaemonEvent event) {
                tools.incrementAndGet();
                toolUpdates.append(JsonSupport.encode(update));
            }
        };
    }

    private static void startWarmup(String harnessSessionId)
            throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("harnessSessionId", harnessSessionId);
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(controlUri("fixture/warm"))
                        .header("Authorization", "Bearer "
                                + requiredEnvironment(
                                        "QWEN_MANAGED_HOSTED_E2E_CONTROL_TOKEN"))
                        .header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(
                                JsonSupport.encode(body)))
                        .build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        assertEquals(202, response.statusCode(), response.body());
    }

    private static Map<String, Object> brokerStatus() throws Exception {
        HttpResponse<String> response = HttpClient.newHttpClient().send(
                HttpRequest.newBuilder(controlUri("fixture/status"))
                        .header("Authorization", "Bearer "
                                + requiredEnvironment(
                                        "QWEN_MANAGED_HOSTED_E2E_CONTROL_TOKEN"))
                        .GET().build(),
                HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        assertEquals(200, response.statusCode(), response.body());
        return JsonSupport.parseObject(response.body(), "fixture status");
    }

    private static Map<String, Object> waitForRuntimeAcquired()
            throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (System.nanoTime() < deadline) {
            Map<String, Object> status = brokerStatus();
            if (requiredLong(status, "runtimeReadyAtEpochMillis") >= 0
                    && JsonSupport.requiredInt(status,
                            "physicalAcquireCount", "fixture status") == 1) {
                return status;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Runtime Session was not acquired");
    }

    private static Map<String, Object> waitForCount(String field,
            int expected, Duration timeout) throws Exception {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            Map<String, Object> status = brokerStatus();
            if (JsonSupport.requiredInt(status, field,
                    "fixture status") == expected) {
                return status;
            }
            Thread.sleep(50);
        }
        throw new AssertionError(field + " did not become " + expected);
    }

    private static void waitForFile(Path path, Duration timeout)
            throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (Files.exists(path)) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("File did not appear: " + path);
    }

    private static void waitForProcessExit(long pid, Duration timeout)
            throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        while (System.nanoTime() < deadline) {
            if (!isProcessAlive(pid)) {
                return;
            }
            Thread.sleep(50);
        }
        throw new AssertionError("Process did not exit: " + pid);
    }

    private static void waitUntil(long epochMillis)
            throws InterruptedException {
        while (System.currentTimeMillis() < epochMillis) {
            Thread.sleep(Math.min(50,
                    epochMillis - System.currentTimeMillis()));
        }
    }

    private static boolean isProcessAlive(long pid) {
        return ProcessHandle.of(pid).map(ProcessHandle::isAlive)
                .orElse(false);
    }

    private static void assertCancelled(PromptTerminal terminal) {
        if (terminal.getKind() == PromptTerminal.Kind.COMPLETE) {
            assertEquals("cancelled", terminal.getStopReason());
        } else {
            assertEquals("-32603", terminal.getCode());
            assertEquals("Request was aborted.", terminal.getMessage());
        }
    }

    private static long requiredLong(Map<String, Object> input,
            String field) {
        Object value = input.get(field);
        if (!(value instanceof Number)) {
            throw new AssertionError(field + " is not numeric");
        }
        return ((Number) value).longValue();
    }

    private static List<?> requiredList(Map<String, Object> input,
            String field) {
        Object value = input.get(field);
        if (!(value instanceof List)) {
            throw new AssertionError(field + " is not a list");
        }
        return (List<?>) value;
    }

    private static URI controlUri(String path) {
        return URI.create(requiredEnvironment(
                "QWEN_MANAGED_HOSTED_E2E_CONTROL_URL")).resolve(path);
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }
}
