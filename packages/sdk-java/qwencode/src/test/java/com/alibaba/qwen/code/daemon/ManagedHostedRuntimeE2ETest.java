package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
import java.util.Map;
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

        try (DaemonClient daemon = DaemonClient.builder()
                .baseUri(URI.create(requiredEnvironment(
                        "QWEN_MANAGED_HOSTED_E2E_BASE_URL")))
                .bearerToken(requiredEnvironment(
                        "QWEN_MANAGED_HOSTED_E2E_TOKEN"))
                .promptObservationTimeout(Duration.ofMinutes(2))
                .heartbeatInterval(Duration.ZERO)
                .build();
                DaemonSessionClient session = daemon.createSession(
                        CreateSessionRequest.builder()
                                .workspaceCwd(workspace)
                                .approvalMode(DaemonApprovalMode.YOLO)
                                .build())) {
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
