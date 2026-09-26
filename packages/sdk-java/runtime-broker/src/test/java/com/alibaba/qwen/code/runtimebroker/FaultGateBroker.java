package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ProxySelector;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import javax.sql.DataSource;

/**
 * One Broker process for the fault gates: the production
 * {@link RuntimeBrokerService} over the JDBC repositories, the production
 * local-process provisioner, and the production HTTP transport. Every request
 * the Broker sends to a Runtime, from the provisioner's health probes to the
 * service's attestations and tool calls, crosses the gate's fault proxy. It
 * reads one JSON command per line on standard input and answers each on
 * standard output.
 */
final class FaultGateBroker {
    private static final Duration COMMAND_TIMEOUT = Duration.ofSeconds(90);
    private static final List<String> WORKER_ENVIRONMENT = List.of("HOME",
            "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "LOGNAME");

    private final RuntimeBrokerService service;
    private final DataSource dataSource;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcRuntimeSessionRepository sessions;
    private final JdbcToolExecutionRepository executions;

    private FaultGateBroker(JSONObject config) {
        dataSource = new DriverManagerDataSource(config.getString("jdbcUrl"),
                "sa", "");
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5))
                .proxy(ProxySelector.of(new InetSocketAddress(
                        InetAddress.getLoopbackAddress(),
                        config.getIntValue("proxyPort"))))
                .build();
        Path cli = Path.of(config.getString("cli"));
        Map<String, String> environment = new LinkedHashMap<>();
        for (String name : WORKER_ENVIRONMENT) {
            String value = System.getenv(name);
            if (value != null) {
                environment.put(name, value);
            }
        }
        ExecutorService workers = Executors.newCachedThreadPool(task -> {
            Thread thread = new Thread(task, "fault-gate-provisioner");
            thread.setDaemon(true);
            return thread;
        });
        LocalProcessRuntimeProvisioner provisioner =
                new LocalProcessRuntimeProvisioner(
                        Path.of(config.getString("stateDir")),
                        // exec keeps the worker's pid; only its standard
                        // error is kept, for the gate's failure report.
                        List.of("/bin/sh", "-c", "exec \"$@\" 2>>\"$0\"",
                                config.getString("workerLog"),
                                config.getString("node"), cli.resolveSibling(
                                        "managed-runtime-worker.js")
                                        .toString()),
                        cli, environment, 4, Duration.ofSeconds(60),
                        Duration.ofSeconds(2), Duration.ofSeconds(5),
                        Duration.ofSeconds(5), client, workers);
        JSONObject scope = config.getJSONObject("scope");
        RuntimeScope runtimeScope = new RuntimeScope(
                scope.getString("tenantId"), scope.getString("workspaceId"),
                scope.getString("workspaceGeneration"),
                scope.getString("canonicalCwd"),
                scope.getString("capabilityDigest"),
                scope.getString("isolationClass"));
        bindings = new JdbcRuntimeBindingRepository(dataSource,
                AesGcmSecretProtector.fromBase64("fault-gate",
                        config.getString("secretKey")));
        sessions = new JdbcRuntimeSessionRepository(dataSource);
        executions = new JdbcToolExecutionRepository(dataSource);
        service = new RuntimeBrokerService(
                harnessSessionId -> CompletableFuture.completedFuture(
                        runtimeScope),
                provisioner,
                new HttpRuntimeTransport(client, Duration.ofMillis(
                        config.getLongValue("attestationTimeoutMillis"))),
                bindings, sessions, executions, config.getString("ownerId"),
                Duration.ofMillis(config.getLongValue("operationLeaseMillis")),
                Duration.ofMillis(config.getLongValue("dispatchLeaseMillis")),
                Duration.ofMinutes(10), Duration.ofSeconds(30));
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, true,
                StandardCharsets.UTF_8);
        // Nothing but replies may reach standard output.
        System.setOut(System.err);
        FaultGateBroker broker = new FaultGateBroker(JSON.parseObject(
                Files.readString(Path.of(args[0]))));
        try (RuntimeBrokerService ignored = broker.service) {
            out.println(JSON.toJSONString(Map.of("ready", true)));
            BufferedReader input = new BufferedReader(new InputStreamReader(
                    System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = input.readLine()) != null) {
                JSONObject command = JSON.parseObject(line);
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("id", command.getLongValue("id"));
                try {
                    reply.put("value", await(broker.run(command)));
                    reply.put("ok", true);
                } catch (Throwable failure) {
                    reply.putAll(failure(failure));
                    reply.put("ok", false);
                }
                out.println(JSON.toJSONString(reply));
            }
        }
    }

    private CompletionStage<Object> run(JSONObject command) {
        String harness = command.getString("harness");
        String session = command.getString("runtimeSession");
        String execution = command.getString("execution");
        return switch (command.getString("op")) {
            case "warm" -> service.warm(harness)
                    .thenApply(ignored -> binding());
            case "acquire" -> service.acquire(harness, session, "bootstrap")
                    .thenApply(ignored -> session(session));
            case "prepare" -> prepare(harness, session,
                    command.getString("promptId"),
                    command.getString("callId"),
                    command.getString("command"));
            case "create" -> {
                JSONObject reference = command.getJSONObject("reference");
                Map<String, Object> created = service.createExecution(
                        command.getString("key"), harness, session,
                        reference.getString("promptId"),
                        reference.getString("callId"),
                        reference.getString("argsDigest"), reference);
                yield CompletableFuture.completedFuture(execution(
                        (String) created.get("executionCallId")));
            }
            case "get" -> {
                service.getExecution(harness, session, execution, null);
                yield CompletableFuture.completedFuture(execution(execution));
            }
            case "cancel" -> service.cancelExecution(harness, session,
                    execution).thenApply(ignored -> execution(execution));
            case "reconcile" -> service.reconcileExecution(harness, session,
                    execution).thenApply(reconciliation -> {
                        Map<String, Object> value = new LinkedHashMap<>();
                        value.put("outcome",
                                reconciliation.getOutcome().name());
                        value.put("runtimeState",
                                reconciliation.getRuntimeState());
                        value.put("record",
                                execution(reconciliation.getRecord()));
                        return value;
                    });
            case "release" -> service.release(harness, session)
                    .thenApply(released -> released);
            case "resolve" -> {
                service.resolveUnknownExecution(harness, session, execution,
                        UnknownExecutionResolution.valueOf(
                                command.getString("resolution")));
                yield CompletableFuture.completedFuture(execution(execution));
            }
            default -> throw new IllegalArgumentException(
                    "unknown command " + command.getString("op"));
        };
    }

    /**
     * Opens one tool turn and prepares a foreground Shell call in it, the
     * way the Hosted Harness does before it creates the execution: the
     * current manifest names the capability and policy, the Runtime builds
     * the invocation, and its pre-tool hook admits it.
     */
    private CompletionStage<Object> prepare(String harness, String session,
            String promptId, String callId, String shellCommand) {
        return control(harness, session, Map.of("kind", "manifest"))
                .thenCompose(manifest -> {
                    Map<String, Object> identity = new LinkedHashMap<>();
                    identity.put("sessionId", session);
                    identity.put("promptId", promptId);
                    identity.put("callId", callId);
                    identity.put("capabilityDigest",
                            manifest.getString("capabilityDigest"));
                    identity.put("policyRevision",
                            manifest.getString("policyRevision"));
                    Map<String, Object> input = new LinkedHashMap<>();
                    input.put("command", shellCommand);
                    input.put("is_background", false);
                    return control(harness, session, Map.of(
                            "kind", "begin-turn", "identity", identity))
                            .thenCompose(ignored -> control(harness, session,
                                    Map.of("kind", "prepare",
                                            "identity", identity,
                                            "toolName", "run_shell_command",
                                            "input", input)));
                })
                .thenCompose(prepared -> {
                    Map<String, Object> reference = new LinkedHashMap<>();
                    for (String field : List.of("sessionId", "promptId",
                            "callId", "capabilityDigest", "policyRevision",
                            "invocationId", "argsDigest")) {
                        reference.put(field, prepared.getString(field));
                    }
                    return control(harness, session, Map.of(
                            "kind", "preflight", "reference", reference))
                            .thenApply(preflight -> {
                                if (!preflight.getBooleanValue(
                                        "shouldProceed")) {
                                    throw new IllegalStateException(
                                            "the pre-tool hook blocked the"
                                                    + " call: " + preflight);
                                }
                                return reference;
                            });
                });
    }

    private CompletionStage<JSONObject> control(String harness,
            String session, Map<String, Object> operation) {
        return service.control(harness, session, operation)
                .thenApply(result -> result == null ? new JSONObject()
                        : JSON.parseObject(JSON.toJSONString(result)));
    }

    /**
     * The binding the scope's slot points at. The rig has one scope, so its
     * one slot names the active binding without rebuilding the placement
     * identity the provisioner derives.
     */
    private Object binding() {
        try (Connection connection = dataSource.getConnection();
                PreparedStatement statement = connection.prepareStatement(
                        "SELECT active_binding_id FROM"
                                + " qwen_runtime_binding_slot");
                ResultSet result = statement.executeQuery()) {
            if (!result.next()) {
                throw new IllegalStateException("no binding slot");
            }
            RuntimeBindingRecord record = bindings.findById(
                    result.getString(1));
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("bindingId", record.getBindingId());
            value.put("generation", record.getGeneration());
            value.put("state", record.getState().name());
            return value;
        } catch (SQLException exception) {
            throw new IllegalStateException(exception);
        }
    }

    private Object session(String runtimeSessionId) {
        RuntimeSessionRecord record = sessions.findById(runtimeSessionId);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("state", record.getState().name());
        value.put("bindingId", record.getBindingId());
        value.put("runtimeGeneration", record.getRuntimeGeneration());
        return value;
    }

    private Object execution(String executionCallId) {
        return execution(executions.findByExecutionCallId(executionCallId));
    }

    private static Object execution(ToolExecutionRecord record) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("executionCallId", record.getExecutionCallId());
        value.put("state", record.getState().name());
        value.put("result", record.getResult());
        value.put("dispatchOwner", record.getDispatchOwner());
        value.put("dispatchGeneration", record.getDispatchGeneration());
        return value;
    }

    private static Object await(CompletionStage<Object> stage)
            throws Exception {
        return stage.toCompletableFuture().get(COMMAND_TIMEOUT.toMillis(),
                TimeUnit.MILLISECONDS);
    }

    private static Map<String, Object> failure(Throwable failure) {
        Throwable cause = failure;
        while ((cause instanceof ExecutionException
                || cause instanceof CompletionException)
                && cause.getCause() != null) {
            cause = cause.getCause();
        }
        Map<String, Object> reply = new LinkedHashMap<>();
        if (cause instanceof RuntimeBrokerException broker) {
            reply.put("status", broker.getStatusCode());
            reply.put("code", broker.getCode());
            reply.put("retryable", broker.isRetryable());
        } else {
            reply.put("status", 0);
            reply.put("code", cause instanceof TimeoutException
                    ? "command_timeout" : cause.getClass().getName());
            reply.put("retryable", false);
        }
        reply.put("message", String.valueOf(cause.getMessage()));
        return reply;
    }
}
