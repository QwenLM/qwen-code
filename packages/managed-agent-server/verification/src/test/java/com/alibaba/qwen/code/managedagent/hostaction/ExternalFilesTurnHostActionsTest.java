package com.alibaba.qwen.code.managedagent.hostaction;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentConfiguration;
import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionExecutor;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionInvocation;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionReceipt;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionResult;
import com.alibaba.qwen.code.managedagent.contracts.hostaction.HostTurnActionSpec;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.ExternalStorageIdentity;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration.StorageAlias;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.managedagent.persistence.ExternalWorkspaceMaterializationStore;
import com.alibaba.qwen.code.managedagent.session.HarnessCoordinator;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.starter.ManagedAgentAutoConfiguration;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.autoconfigure.jackson.JacksonAutoConfiguration;
import org.springframework.boot.autoconfigure.task.TaskSchedulingAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.LockSupport;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class ExternalFilesTurnHostActionsTest {
    private static final String CAPABILITY_DIGEST = "sha256:" + "a".repeat(64);
    private static final String BROKER_TOKEN = "broker-secret-token";
    private static final String HARNESS_TOKEN = "harness-secret-token";
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {
    };

    private static HostTurnActionSpec postCommentSpec(String contextRef) {
        Map<String, Object> bodyProp = Map.of(
                "type", "string",
                "minLength", 1,
                "maxLength", 4000);
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        schema.put("properties", Map.of("body", bodyProp));
        schema.put("required", List.of("body"));
        schema.put("additionalProperties", false);
        return new HostTurnActionSpec(
                "post_pr_comment",
                "Post a pull request comment on the host-bound task.",
                schema,
                contextRef);
    }

    @Test
    void admitsExternalFilesHostActionsExecutesViaBrokerReplaysIdempotentlyAndFencesWriters() throws Exception {
        List<Map<String, Object>> capturedPrompts = new CopyOnWriteArrayList<>();
        HttpServer harnessStub = startHarnessStub(capturedPrompts, true);
        int harnessPort = harnessStub.getAddress().getPort();
        List<HostTurnActionInvocation> invocations = new CopyOnWriteArrayList<>();
        HostTurnActionExecutor executor = invocation -> {
            invocations.add(invocation);
            return HostTurnActionResult.success(
                    "Posted comment ic-4201",
                    Map.of("commentId", "ic-4201", "contextEcho", String.valueOf(invocation.contextRef())));
        };
        try {
            embeddedRunner(harnessPort)
                    .withBean(ExternalRuntimeClient.class, () -> mock(ExternalRuntimeClient.class))
                    .withBean(HostTurnActionExecutor.class, () -> executor)
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        assertThat(context.getBeansWithAnnotation(RestController.class)).isEmpty();
                        ReflectionTestUtils.setField(context.getBean(HarnessCoordinator.class),
                                "runtimeWarmer", disabledWarmer());
                        ManagedAgentService service = context.getBean(ManagedAgentService.class);
                        EmbeddedRuntimeBroker broker = context.getBean(EmbeddedRuntimeBroker.class);
                        JdbcTemplate jdbc = context.getBean("managedJdbcTemplate", JdbcTemplate.class);
                        PlatformTransactionManager txManager = context.getBean(
                                "managedAgentTransactionManager", PlatformTransactionManager.class);
                        TransactionTemplate tx = new TransactionTemplate(txManager);

                        String tenant = UUID.randomUUID().toString();
                        registerExternalWorkspace(context.getBean(ExternalStorageRegistrationStore.class),
                                context.getBean(ExternalWorkspaceMaterializationStore.class),
                                tenant, "ws-ext", "actor-1");

                        HostTurnActionSpec spec = postCommentSpec("task-run:pr-42");
                        List<InputBlock> initialInput = List.of(new InputBlock("text", "Review PR #42 and comment"));
                        CommandAdmission created = tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-ext-1", "qwen-code", null, "PR Review", null,
                                initialInput, new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES, List.of(spec)));
                        assertThat(created).isNotNull();
                        assertThat(created.replayed()).isFalse();
                        assertThat(created.turnId()).isNotBlank();

                        // Replay with identical hostActions succeeds; altered contextRef conflicts.
                        CommandAdmission replayedCreate = tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-ext-1", "qwen-code", null, "PR Review", null,
                                initialInput, new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES, List.of(spec)));
                        assertThat(replayedCreate.replayed()).isTrue();
                        assertThat(replayedCreate.sessionId()).isEqualTo(created.sessionId());
                        assertCode(() -> tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-ext-1", "qwen-code", null, "PR Review", null,
                                initialInput, new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES,
                                List.of(postCommentSpec("task-run:pr-99")))), "idempotency_conflict");

                        Map<String, Object> promptPayload = awaitFirstPrompt(capturedPrompts);
                        @SuppressWarnings("unchecked")
                        List<Map<String, Object>> wireActions =
                                (List<Map<String, Object>>) promptPayload.get("hostActions");
                        assertThat(wireActions).hasSize(1);
                        assertThat(wireActions.getFirst()).containsEntry("name", "post_pr_comment");
                        assertThat(wireActions.getFirst()).doesNotContainKey("contextRef");
                        String rawWire = JSON.writeValueAsString(promptPayload);
                        assertThat(rawWire).doesNotContain("task-run:pr-42");

                        String promptId = String.valueOf(promptPayload.get("promptId"));
                        Map<String, Object> args = Map.of("body", "All checks green; LGTM.");
                        String argsDigest = "sha256:" + DigestUtils.sha256Hex(
                                JSON.writeValueAsBytes(new TreeMap<>(args)));

                        // First Broker callback executes the host action and persists the receipt.
                        HttpResponse first = postHostAction(broker.getBaseUri(), tenant, created.sessionId(), Map.of(
                                "promptId", promptId,
                                "callId", "call-comment-1",
                                "actionName", "post_pr_comment",
                                "arguments", args,
                                "argsDigest", argsDigest));
                        assertThat(first.status()).isEqualTo(200);
                        assertThat(first.body()).containsEntry("turnId", created.turnId())
                                .containsEntry("promptId", promptId)
                                .containsEntry("callId", "call-comment-1")
                                .containsEntry("isError", false)
                                .containsEntry("replayed", false);
                        @SuppressWarnings("unchecked")
                        Map<String, Object> output = (Map<String, Object>) first.body().get("output");
                        assertThat(output).containsEntry("commentId", "ic-4201")
                                .containsEntry("contextEcho", "task-run:pr-42");
                        assertThat(invocations).hasSize(1);
                        assertThat(invocations.getFirst().tenantId()).isEqualTo(tenant);
                        assertThat(invocations.getFirst().sessionId()).isEqualTo(created.sessionId());
                        assertThat(invocations.getFirst().turnId()).isEqualTo(created.turnId());
                        assertThat(invocations.getFirst().contextRef()).isEqualTo("task-run:pr-42");

                        // Retried callback after an interrupted HTTP response replays without re-running executor.
                        HttpResponse second = postHostAction(broker.getBaseUri(), tenant, created.sessionId(), Map.of(
                                "promptId", promptId,
                                "callId", "call-comment-1",
                                "actionName", "post_pr_comment",
                                "arguments", args,
                                "argsDigest", argsDigest));
                        assertThat(second.status()).isEqualTo(200);
                        assertThat(second.body()).containsEntry("replayed", true);
                        @SuppressWarnings("unchecked")
                        Map<String, Object> replayedOutput = (Map<String, Object>) second.body().get("output");
                        assertThat(replayedOutput).containsEntry("commentId", "ic-4201");
                        assertThat(invocations).hasSize(1);

                        // Conflicting args for the same (promptId, callId) fail with 409.
                        Map<String, Object> otherArgs = Map.of("body", "Different comment");
                        String otherDigest = "sha256:" + DigestUtils.sha256Hex(
                                JSON.writeValueAsBytes(new TreeMap<>(otherArgs)));
                        HttpResponse conflict = postHostAction(broker.getBaseUri(), tenant, created.sessionId(), Map.of(
                                "promptId", promptId,
                                "callId", "call-comment-1",
                                "actionName", "post_pr_comment",
                                "arguments", otherArgs,
                                "argsDigest", otherDigest));
                        assertThat(conflict.status()).isEqualTo(409);
                        assertThat(conflict.body()).containsEntry("code", "runtime_idempotency_conflict");
                        assertThat(invocations).hasSize(1);

                        // Writer-generation fencing rejects stale writer leases before invoking executor.
                        long now = System.currentTimeMillis();
                        jdbc.update("DELETE FROM ma_session_head WHERE tenant_id = ? AND harness_session_id = ?",
                                tenant, created.sessionId());
                        jdbc.update("INSERT INTO ma_session_head (tenant_id, workspace_id, session_id,"
                                        + " harness_session_id, head_kind, state, writer_generation, writer_id,"
                                        + " writer_lease_until, journal_revision, committed_sequence,"
                                        + " activation_epoch, gmt_create, gmt_modified)"
                                        + " VALUES (?, 'ws-ext', ?, ?, 'MANAGED_SESSION', 'ACTIVE', 2,"
                                        + " 'writer-current', ?, 1, 1, 1, ?, ?)",
                                tenant, created.sessionId(), created.sessionId(), now + 60_000L, now, now);
                        Map<String, Object> fencedPayload = new LinkedHashMap<>();
                        fencedPayload.put("promptId", promptId);
                        fencedPayload.put("callId", "call-comment-2");
                        fencedPayload.put("actionName", "post_pr_comment");
                        fencedPayload.put("arguments", args);
                        fencedPayload.put("argsDigest", argsDigest);
                        fencedPayload.put("writerId", "writer-current");
                        fencedPayload.put("writerGeneration", 1L);
                        HttpResponse fenced = postHostAction(broker.getBaseUri(), tenant, created.sessionId(), fencedPayload);
                        assertThat(fenced.status()).isEqualTo(409);
                        assertThat(fenced.body()).containsEntry("code", "managed_session_writer_conflict");
                        assertThat(invocations).hasSize(1);

                        fencedPayload.put("writerGeneration", 2L);
                        HttpResponse unfenced = postHostAction(broker.getBaseUri(), tenant, created.sessionId(), fencedPayload);
                        assertThat(unfenced.status()).isEqualTo(200);
                        assertThat(invocations).hasSize(2);

                        // Host reconciliation reads durable receipts associated with (sessionId, turnId, callId).
                        List<HostTurnActionReceipt> receipts = service.listTurnHostActionReceipts(
                                tenant, "actor-1", created.sessionId(), created.turnId());
                        assertThat(receipts).hasSize(2);
                        assertThat(receipts.getFirst().callId()).isEqualTo("call-comment-1");
                        assertThat(receipts.getFirst().state()).isEqualTo("COMPLETED");
                        assertThat(receipts.getFirst().result().output()).containsEntry("commentId", "ic-4201");
                    });
        } finally {
            harnessStub.stop(0);
        }
    }

    @Test
    void rejectsUnsupportedProfilesMissingExecutorAndStarterRemainsControllerFree() throws Exception {
        List<Map<String, Object>> capturedPrompts = new CopyOnWriteArrayList<>();
        HttpServer harnessStub = startHarnessStub(capturedPrompts, true);
        int harnessPort = harnessStub.getAddress().getPort();
        try {
            // 1. Starter auto-configuration mounts zero @RestController beans and wires host executor.
            new ApplicationContextRunner()
                    .withConfiguration(AutoConfigurations.of(
                            ManagedAgentAutoConfiguration.class,
                            JacksonAutoConfiguration.class,
                            TaskSchedulingAutoConfiguration.class))
                    .withBean(HostTurnActionExecutor.class,
                            () -> invocation -> HostTurnActionResult.success("ok", Map.of("commentId", "c-1")))
                    .withPropertyValues(
                            "qwen.managed-agent.enabled=true",
                            "qwen.managed-agent.datasource.url=" + h2Url())
                    .run(starterContext -> {
                        assertThat(starterContext).hasNotFailed();
                        assertThat(starterContext.getBeansWithAnnotation(RestController.class)).isEmpty();
                        assertThat(starterContext.getBean(ManagedAgentService.class)).isNotNull();
                    });

            // 2. Ordinary files/1 and external-shell/1 reject hostActions; submitTurn enforces executor presence.
            embeddedRunner(harnessPort)
                    .withBean(ExternalRuntimeClient.class, () -> mock(ExternalRuntimeClient.class))
                    .withBean(HostTurnActionExecutor.class,
                            () -> invocation -> HostTurnActionResult.success("ok", Map.of("commentId", "c-2")))
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        ManagedAgentService service = context.getBean(ManagedAgentService.class);
                        JdbcTemplate jdbc = context.getBean("managedJdbcTemplate", JdbcTemplate.class);
                        TransactionTemplate tx = new TransactionTemplate(context.getBean(
                                "managedAgentTransactionManager", PlatformTransactionManager.class));
                        String tenant = UUID.randomUUID().toString();
                        registerExternalWorkspace(context.getBean(ExternalStorageRegistrationStore.class),
                                context.getBean(ExternalWorkspaceMaterializationStore.class),
                                tenant, "ws-ext", "actor-1");

                        HostTurnActionSpec spec = postCommentSpec("ctx-1");
                        List<InputBlock> input = List.of(new InputBlock("text", "hi"));

                        // External Shell profile rejects hostActions on create.
                        assertCode(() -> tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-shell", "qwen-code", null, null, null,
                                input, new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_SHELL, List.of(spec))),
                                "host_actions_profile_unsupported");

                        // External Files Session admits unannotated creation and annotated submitTurn + replay.
                        CommandAdmission extSession = tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-ext-empty", "qwen-code", null, null, null,
                                List.of(), new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES, null));
                        CommandAdmission turn1 = tx.execute(status -> service.submitTurn(
                                tenant, "actor-1", "submit-ext-1", extSession.sessionId(),
                                input, List.of(spec)));
                        assertThat(turn1.replayed()).isFalse();
                        CommandAdmission replayTurn1 = tx.execute(status -> service.submitTurn(
                                tenant, "actor-1", "submit-ext-1", extSession.sessionId(),
                                input, List.of(spec)));
                        assertThat(replayTurn1.replayed()).isTrue();
                        assertThat(replayTurn1.turnId()).isEqualTo(turn1.turnId());
                        assertCode(() -> tx.execute(status -> service.submitTurn(
                                tenant, "actor-1", "submit-ext-1", extSession.sessionId(),
                                input, List.of(postCommentSpec("ctx-other")))), "idempotency_conflict");

                        // Ordinary files/1 Session rejects hostActions on submitTurn.
                        CommandAdmission stdSession = tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-std", "qwen-code", null, null, null,
                                List.of(), new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES, null));
                        jdbc.update("UPDATE ma_session SET tool_profile = ? WHERE tenant_id = ? AND session_id = ?",
                                WorkspaceToolProfiles.FILES, tenant, stdSession.sessionId());
                        assertCode(() -> tx.execute(status -> service.submitTurn(
                                tenant, "actor-1", "submit-std", stdSession.sessionId(),
                                input, List.of(spec))), "host_actions_profile_unsupported");
                    });

            // 3. Without a HostTurnActionExecutor bean, turnHostActions fail closed with host_actions_unavailable.
            embeddedRunner(harnessPort)
                    .withBean(ExternalRuntimeClient.class, () -> mock(ExternalRuntimeClient.class))
                    .run(context -> {
                        assertThat(context).hasNotFailed();
                        ManagedAgentService service = context.getBean(ManagedAgentService.class);
                        TransactionTemplate tx = new TransactionTemplate(context.getBean(
                                "managedAgentTransactionManager", PlatformTransactionManager.class));
                        String tenant = UUID.randomUUID().toString();
                        registerExternalWorkspace(context.getBean(ExternalStorageRegistrationStore.class),
                                context.getBean(ExternalWorkspaceMaterializationStore.class),
                                tenant, "ws-ext", "actor-1");
                        assertCode(() -> tx.execute(status -> service.createWorkspaceSession(
                                tenant, "actor-1", "create-no-exec", "qwen-code", null, null, null,
                                List.of(new InputBlock("text", "hi")),
                                new WorkspaceSelection("ws-ext", "."), "default", null,
                                null, null, null, null, null, null,
                                WorkspaceToolProfiles.EXTERNAL_FILES,
                                List.of(postCommentSpec("ctx-1")))), "host_actions_unavailable");
                    });
        } finally {
            harnessStub.stop(0);
        }
    }

    private static ApplicationContextRunner embeddedRunner(int harnessPort) {
        return new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(
                        JacksonAutoConfiguration.class,
                        TaskSchedulingAutoConfiguration.class))
                .withUserConfiguration(ManagedAgentConfiguration.class)
                .withPropertyValues(
                        "qwen.managed-agent.datasource.url=" + h2Url(),
                        "qwen.managed-agent.harness.enabled=true",
                        "qwen.managed-agent.harness.workspace-files-enabled=true",
                        "qwen.managed-agent.harness.base-url=http://127.0.0.1:" + harnessPort,
                        "qwen.managed-agent.harness.token=" + HARNESS_TOKEN,
                        "qwen.managed-agent.harness.capability-digest=" + CAPABILITY_DIGEST,
                        "qwen.managed-agent.session-store.enabled=true",
                        "qwen.managed-agent.session-store.base-url=http://127.0.0.1:" + harnessPort,
                        "qwen.managed-agent.session-store.binding-key=" + "k".repeat(32),
                        "qwen.managed-agent.runtime-broker.enabled=true",
                        "qwen.managed-agent.runtime-broker.host=127.0.0.1",
                        "qwen.managed-agent.runtime-broker.port=0",
                        "qwen.managed-agent.runtime-broker.token=" + BROKER_TOKEN,
                        "qwen.managed-agent.runtime-broker.credential-key-id=test-key",
                        "qwen.managed-agent.runtime-broker.credential-key="
                                + Base64.getEncoder().encodeToString(new byte[32]),
                        "qwen.managed-agent.runtime-broker.provisioner=external-workspace",
                        "qwen.managed-agent.runtime-broker.external-provider-id=provider",
                        "qwen.managed-agent.runtime-broker.workspace-id=ws-ext",
                        "qwen.managed-agent.runtime-broker.workspace-cwd=/worker/workspace",
                        "qwen.managed-agent.runtime-broker.trusted-local-reboot-recovery=false");
    }

    private static void registerExternalWorkspace(ExternalStorageRegistrationStore registrations,
            ExternalWorkspaceMaterializationStore materializations,
            String tenant, String workspaceId, String actorId) {
        ExternalStorageRegistration registration = new ExternalStorageRegistration(
                new ExternalStorageIdentity("provider", tenant + "-" + workspaceId, 1),
                new StorageAlias(workspaceId, "/aliases/" + tenant + "/" + workspaceId, "/worker/workspace"));
        registrations.registerExternalStorage(tenant, "reg-" + workspaceId, registration);
        materializations.materialize(tenant, workspaceId, "External WS", actorId, "mat-" + workspaceId);
    }

    private static RuntimeWarmer disabledWarmer() {
        return new RuntimeWarmer() {
            @Override
            public boolean isEnabled() {
                return false;
            }

            @Override
            public CompletionStage<Void> warm(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }

            @Override
            public CompletionStage<Void> drain(String sessionId) {
                return CompletableFuture.completedFuture(null);
            }
        };
    }

    private static HttpServer startHarnessStub(List<Map<String, Object>> capturedPrompts,
            boolean advertiseHostActions) throws IOException {
        String bootId = UUID.randomUUID().toString();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "harness-stub");
            thread.setDaemon(true);
            return thread;
        }));
        server.createContext("/", exchange -> handleHarnessExchange(
                exchange, bootId, capturedPrompts, advertiseHostActions));
        server.start();
        return server;
    }

    private static void handleHarnessExchange(HttpExchange exchange, String bootId,
            List<Map<String, Object>> capturedPrompts, boolean advertiseHostActions) throws IOException {
        String path = exchange.getRequestURI().getPath();
        byte[] requestBytes = exchange.getRequestBody().readAllBytes();
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("X-Qwen-Harness-Protocol-Version", "1");
        exchange.getResponseHeaders().set("X-Qwen-Harness-Boot-Id", bootId);
        if ("/capabilities".equals(path)) {
            List<String> features = advertiseHostActions
                    ? List.of("hosted-workspace-external-files/1", "hosted-workspace-external-shell/1",
                            "hosted-turn-host-actions/1", "approval-selection/1")
                    : List.of("hosted-workspace-external-files/1", "hosted-workspace-external-shell/1",
                            "approval-selection/1");
            Map<String, Object> hosted = new LinkedHashMap<>();
            hosted.put("protocolVersions", Map.of("current", 1, "supported", List.of(1)));
            hosted.put("bootId", bootId);
            hosted.put("capabilityDigest", CAPABILITY_DIGEST);
            hosted.put("lifecycleProtocolVersion", 1);
            hosted.put("lifecycleV2Profiles", List.of("hosted-workspace-files/1", "hosted-workspace-shell/1"));
            hosted.put("features", features);
            Map<String, Object> capabilities = new LinkedHashMap<>();
            capabilities.put("v", 1);
            capabilities.put("transports", List.of("rest"));
            capabilities.put("features", List.of("hosted_harness_private_v1", "managed_session_journal_delta_v1"));
            capabilities.put("hostedHarness", hosted);
            byte[] out = JSON.writeValueAsBytes(capabilities);
            exchange.sendResponseHeaders(200, out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
            return;
        }
        if ("/session".equals(path) || path.endsWith("/load")) {
            Map<String, Object> reqBody = requestBytes.length == 0
                    ? Map.of() : JSON.readValue(requestBytes, MAP_TYPE);
            String sessionId = reqBody.get("sessionId") instanceof String s ? s : extractSessionId(path);
            Map<String, Object> created = new LinkedHashMap<>();
            created.put("sessionId", sessionId);
            created.put("clientId", "client-1");
            created.put("workspaceCwd", "/worker/workspace");
            created.put("approvalMode", reqBody.getOrDefault("approvalMode", "default"));
            byte[] out = JSON.writeValueAsBytes(created);
            exchange.sendResponseHeaders(200, out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
            return;
        }
        if (path.endsWith("/prompt")) {
            Map<String, Object> body = JSON.readValue(requestBytes, MAP_TYPE);
            capturedPrompts.add(body);
            byte[] out = JSON.writeValueAsBytes(Map.of("promptId", body.get("promptId")));
            exchange.sendResponseHeaders(202, out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
            return;
        }
        if (path.endsWith("/events")) {
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
            try {
                exchange.getResponseBody().write(": keepalive\n\n".getBytes(StandardCharsets.UTF_8));
                exchange.getResponseBody().flush();
                LockSupport.parkNanos(TimeUnit.SECONDS.toNanos(15));
            } catch (IOException ignored) {
                // Closed on test teardown.
            } finally {
                exchange.close();
            }
            return;
        }
        byte[] out = "{}".getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, out.length);
        exchange.getResponseBody().write(out);
        exchange.close();
    }

    private static String extractSessionId(String path) {
        String[] parts = path.split("/");
        for (int i = 0; i < parts.length - 1; i++) {
            if ("session".equals(parts[i])) {
                return parts[i + 1];
            }
        }
        return UUID.randomUUID().toString();
    }

    private static Map<String, Object> awaitFirstPrompt(List<Map<String, Object>> capturedPrompts) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (capturedPrompts.isEmpty() && System.nanoTime() < deadline) {
            LockSupport.parkNanos(TimeUnit.MILLISECONDS.toNanos(25));
        }
        assertThat(capturedPrompts).as("Expected Harness /prompt submission").isNotEmpty();
        return capturedPrompts.getFirst();
    }

    private record HttpResponse(int status, Map<String, Object> body) {
    }

    private static HttpResponse postHostAction(URI baseUri, String tenantId, String sessionId,
            Map<String, Object> payload) throws IOException {
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("protocolVersion", 1);
        envelope.put("requestId", UUID.randomUUID().toString());
        envelope.put("harnessSessionId", sessionId);
        envelope.put("tenantId", tenantId);
        envelope.put("workspaceId", "ws-ext");
        envelope.putAll(payload);
        URI uri = baseUri.resolve("/internal/runtime-broker/v1/harness-sessions/"
                + sessionId + "/host-actions/execute");
        HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Authorization", "Bearer " + BROKER_TOKEN);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setDoOutput(true);
        conn.getOutputStream().write(JSON.writeValueAsBytes(envelope));
        int code = conn.getResponseCode();
        byte[] raw = (code >= 400 ? conn.getErrorStream() : conn.getInputStream()).readAllBytes();
        conn.disconnect();
        return new HttpResponse(code, JSON.readValue(raw, MAP_TYPE));
    }

    private static void assertCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private static String h2Url() {
        return "jdbc:h2:mem:host-actions-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1";
    }
}
