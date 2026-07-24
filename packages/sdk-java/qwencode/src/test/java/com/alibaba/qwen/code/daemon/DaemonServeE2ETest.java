package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

@Tag("daemon-integration")
@EnabledIfEnvironmentVariable(named = "QWEN_DAEMON_E2E_BASE_URL", matches = ".+")
class DaemonServeE2ETest {
    @Test
    void runsPromptToolPermissionAndTerminalAgainstRealDaemon() throws Exception {
        String workspace = System.getenv("QWEN_DAEMON_E2E_WORKSPACE");
        String expectedText = System.getenv().getOrDefault(
                "QWEN_DAEMON_E2E_EXPECTED_TEXT", "java daemon e2e complete");

        try (DaemonClient daemon = newDaemonClient();
                DaemonSessionClient session = createSession(daemon)) {
            AtomicInteger tools = new AtomicInteger();
            AtomicInteger permissions = new AtomicInteger();
            StringBuilder text = new StringBuilder();
            PromptObserver observer = new PromptObserver() {
                @Override
                public void onText(String chunk, DaemonEvent event) {
                    text.append(chunk);
                }

                @Override
                public void onTool(Map<String, Object> update,
                        DaemonEvent event) {
                    tools.incrementAndGet();
                }

                @Override
                public void onPermission(PermissionRequest permission,
                        DaemonEvent event) {
                    permissions.incrementAndGet();
                    assertTrue(session.respondToPermission(
                            permission.getRequestId(),
                            PermissionResponse.selected(firstOption(permission))));
                }

                @Override
                public void onEvent(DaemonEvent event) {
                    System.out.println("Java daemon E2E event: "
                            + event.getType() + " #" + event.getId());
                }
            };

            PromptCall call = session.startPrompt(PromptRequest.text(
                    "Create the requested test file, then report completion."),
                    observer);
            PromptAcceptance acceptance = call.acceptanceFuture()
                    .orTimeout(5, TimeUnit.SECONDS).join();
            assertTrue(acceptance.getEventEpoch() != null);
            PromptTerminal terminal = call.completionFuture()
                    .orTimeout(30, TimeUnit.SECONDS).join();
            assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
            assertTrue(text.toString().contains(expectedText));
            assertTrue(tools.get() > 0);
            assertTrue(permissions.get() > 0);
            if (workspace != null && !workspace.isBlank()) {
                assertEquals("created by Java daemon E2E", Files.readString(
                        Path.of(workspace, "created.txt"),
                        StandardCharsets.UTF_8));
            }
        }
    }

    @Test
    void deadlineTerminalIsReliableAndSessionRemainsReusable() {
        String deadlinePrompt = requiredEnvironment(
                "QWEN_DAEMON_E2E_DEADLINE_PROMPT");
        String directPrompt = requiredEnvironment(
                "QWEN_DAEMON_E2E_DIRECT_PROMPT");
        String expectedText = System.getenv().getOrDefault(
                "QWEN_DAEMON_E2E_EXPECTED_TEXT", "java daemon e2e complete");

        try (DaemonClient daemon = newDaemonClient();
                DaemonSessionClient session = createSession(daemon)) {
            PromptTurnException failure = assertThrows(PromptTurnException.class,
                    () -> session.promptText(PromptRequest.builder()
                            .addText(deadlinePrompt)
                            .deadline(Duration.ofMillis(500))
                            .build()));
            assertEquals("prompt_deadline_exceeded",
                    failure.getTerminal().getCode());

            PromptTextResult followUp = session.promptText(directPrompt);
            assertEquals(PromptTerminal.Kind.COMPLETE,
                    followUp.getTerminal().getKind());
            assertTrue(followUp.getText().contains(expectedText));
        }
    }

    @Test
    void cancelledPromptReceivesReliableTerminal() throws Exception {
        String cancelPrompt = requiredEnvironment(
                "QWEN_DAEMON_E2E_CANCEL_PROMPT");
        String directPrompt = requiredEnvironment(
                "QWEN_DAEMON_E2E_DIRECT_PROMPT");
        String expectedText = System.getenv().getOrDefault(
                "QWEN_DAEMON_E2E_EXPECTED_TEXT", "java daemon e2e complete");
        CountDownLatch streamReady = new CountDownLatch(1);

        try (DaemonClient daemon = newDaemonClient();
                DaemonSessionClient session = createSession(daemon)) {
            PromptCall call = session.startPrompt(PromptRequest.text(cancelPrompt),
                    streamReadyObserver(streamReady));
            call.acceptanceFuture().get(5, TimeUnit.SECONDS);
            assertTrue(streamReady.await(5, TimeUnit.SECONDS));
            session.cancelActivePrompt();

            PromptTerminal terminal = call.completionFuture()
                    .get(10, TimeUnit.SECONDS);
            if (terminal.getKind() == PromptTerminal.Kind.COMPLETE) {
                assertEquals("cancelled", terminal.getStopReason());
            } else {
                assertEquals("-32603", terminal.getCode());
                assertEquals("Request was aborted.", terminal.getMessage());
            }

            PromptTextResult followUp = session.promptText(directPrompt);
            assertTrue(followUp.getText().contains(expectedText));
        }
    }

    @Test
    void teardownDeliversTerminalBeforeSessionFailure() throws Exception {
        String teardownPrompt = requiredEnvironment(
                "QWEN_DAEMON_E2E_TEARDOWN_PROMPT");
        String baseUrl = requiredEnvironment("QWEN_DAEMON_E2E_BASE_URL");
        String token = System.getenv("QWEN_DAEMON_E2E_TOKEN");
        CountDownLatch permissionPending = new CountDownLatch(1);

        try (DaemonClient daemon = newDaemonClient()) {
            DaemonSessionClient session = createSession(daemon);
            try {
                PromptCall call = session.startPrompt(
                        PromptRequest.text(teardownPrompt),
                        eventObserver("permission_request", permissionPending));
                call.acceptanceFuture().get(5, TimeUnit.SECONDS);
                assertTrue(permissionPending.await(10, TimeUnit.SECONDS));

                HttpRequest.Builder request = HttpRequest.newBuilder()
                        .uri(URI.create(baseUrl + "/session/"
                                + session.getSessionId()))
                        .header("X-Qwen-Client-Id", session.getClientId())
                        .DELETE();
                if (token != null && !token.isBlank()) {
                    request.header("Authorization", "Bearer " + token);
                }
                try {
                    HttpResponse<Void> response = HttpClient.newBuilder()
                            .version(HttpClient.Version.HTTP_1_1)
                            .build()
                            .send(request.build(),
                                    HttpResponse.BodyHandlers.discarding());
                    assertEquals(204, response.statusCode());
                } catch (java.io.IOException ignored) {
                    // The terminal below proves that the ambiguous DELETE ran.
                }

                PromptTerminal terminal = call.completionFuture()
                        .get(10, TimeUnit.SECONDS);
                assertEquals(PromptTerminal.Kind.COMPLETE, terminal.getKind());
                assertEquals("cancelled", terminal.getStopReason());
            } finally {
                session.destroySession();
            }
        }
    }

    private static DaemonClient newDaemonClient() {
        String token = System.getenv("QWEN_DAEMON_E2E_TOKEN");
        DaemonClient.Builder builder = DaemonClient.builder()
                .baseUri(URI.create(requiredEnvironment(
                        "QWEN_DAEMON_E2E_BASE_URL")))
                .heartbeatInterval(Duration.ZERO);
        if (token != null && !token.isBlank()) {
            builder.bearerToken(token);
        }
        return builder.build();
    }

    private static DaemonSessionClient createSession(DaemonClient daemon) {
        String workspace = System.getenv("QWEN_DAEMON_E2E_WORKSPACE");
        CreateSessionRequest.Builder request = CreateSessionRequest.builder()
                .approvalMode(DaemonApprovalMode.DEFAULT);
        if (workspace != null && !workspace.isBlank()) {
            request.workspaceCwd(workspace);
        }
        return daemon.createSession(request.build());
    }

    private static PromptObserver streamReadyObserver(CountDownLatch ready) {
        return eventObserver("replay_complete", ready);
    }

    private static PromptObserver eventObserver(String eventType,
            CountDownLatch ready) {
        return new PromptObserver() {
            @Override
            public void onEvent(DaemonEvent event) {
                if (eventType.equals(event.getType())) {
                    ready.countDown();
                }
            }
        };
    }

    private static String requiredEnvironment(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }

    private static String firstOption(PermissionRequest permission) {
        for (Object option : permission.getOptions()) {
            if (option instanceof Map) {
                Object optionId = ((Map<?, ?>) option).get("optionId");
                if (optionId instanceof String) {
                    return (String) optionId;
                }
            }
        }
        throw new AssertionError("Permission request did not contain an optionId");
    }
}
