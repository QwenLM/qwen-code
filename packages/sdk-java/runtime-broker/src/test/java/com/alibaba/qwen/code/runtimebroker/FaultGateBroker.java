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
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import javax.sql.DataSource;

/**
 * One Broker process for the fault gates: the production
 * {@link RuntimeBrokerService} over the JDBC repositories, the production
 * local-process provisioner, and the production HTTP transport routed through
 * the gate's fault proxy. It reads one JSON command per line on standard
 * input and answers each on standard output.
 */
final class FaultGateBroker {
    private static final Duration COMMAND_TIMEOUT = Duration.ofSeconds(90);

    private FaultGateBroker() {
    }

    public static void main(String[] args) throws Exception {
        PrintStream out = new PrintStream(System.out, true,
                StandardCharsets.UTF_8);
        // Nothing but replies may reach standard output.
        System.setOut(System.err);
        JSONObject config = JSON.parseObject(Files.readString(
                Path.of(args[0])));
        try (RuntimeBrokerService service = service(config)) {
            out.println(JSON.toJSONString(Map.of("ready", true)));
            BufferedReader input = new BufferedReader(new InputStreamReader(
                    System.in, StandardCharsets.UTF_8));
            String line;
            while ((line = input.readLine()) != null) {
                JSONObject command = JSON.parseObject(line);
                Map<String, Object> reply = new LinkedHashMap<>();
                reply.put("id", command.getLongValue("id"));
                try {
                    reply.put("value", await(run(service, command)));
                    reply.put("ok", true);
                } catch (Throwable failure) {
                    reply.putAll(failure(failure));
                    reply.put("ok", false);
                }
                out.println(JSON.toJSONString(reply));
            }
        }
    }

    private static RuntimeBrokerService service(JSONObject config) {
        DataSource dataSource = new DriverManagerDataSource(
                config.getString("jdbcUrl"), "sa", "");
        HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5))
                .proxy(ProxySelector.of(new InetSocketAddress(
                        InetAddress.getLoopbackAddress(),
                        config.getIntValue("proxyPort"))))
                .build();
        HttpRuntimeTransport runtime = new HttpRuntimeTransport(client,
                Duration.ofMillis(config.getLongValue("requestTimeoutMillis")));
        LocalProcessRuntimeProvisioner local =
                new LocalProcessRuntimeProvisioner(List.of(
                        config.getString("node"), config.getString("cli"),
                        "managed-runtime-worker"),
                        Path.of(config.getString("stateDir")), runtime);
        String records = config.getString("records");
        RuntimeProvisioner provisioner = records == null ? local
                : new RecoverableProcessProvisioner(local, runtime,
                        Path.of(records));
        JSONObject scope = config.getJSONObject("scope");
        RuntimeScope runtimeScope = new RuntimeScope(
                scope.getString("tenantId"), scope.getString("workspaceId"),
                scope.getString("workspaceGeneration"),
                scope.getString("canonicalCwd"),
                scope.getString("capabilityDigest"),
                scope.getString("isolationClass"));
        return new RuntimeBrokerService(
                harnessSessionId -> CompletableFuture.completedFuture(
                        runtimeScope),
                provisioner, new FaultGateTransport(runtime),
                new JdbcRuntimeBindingRepository(dataSource,
                        AesGcmSecretProtector.fromBase64("fault-gate",
                                config.getString("secretKey"))),
                new JdbcRuntimeSessionRepository(dataSource),
                new JdbcToolExecutionRepository(dataSource),
                config.getString("ownerId"),
                Duration.ofMillis(config.getLongValue("operationLeaseMillis")),
                Duration.ofMillis(config.getLongValue("dispatchLeaseMillis")));
    }

    private static CompletionStage<Object> run(RuntimeBrokerService service,
            JSONObject command) {
        String harness = command.getString("harness");
        String session = command.getString("runtimeSession");
        String execution = command.getString("execution");
        return switch (command.getString("op")) {
            case "warm" -> service.warm(harness)
                    .thenApply(FaultGateBroker::binding);
            case "acquire" -> service.acquire(harness, session, "bootstrap")
                    .thenApply(record -> Map.of(
                            "state", record.getState().name(),
                            "bindingId", record.getBindingId(),
                            "runtimeGeneration",
                            record.getRuntimeGeneration()));
            case "create" -> service.createExecution(harness, session,
                    command.getString("key"),
                    command.getJSONObject("reference"))
                    .thenApply(FaultGateBroker::execution);
            case "get" -> service.getExecution(harness, session, execution)
                    .thenApply(FaultGateBroker::execution);
            case "cancel" -> service.cancelExecution(harness, session,
                    execution).thenApply(FaultGateBroker::execution);
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
            default -> throw new IllegalArgumentException(
                    "unknown command " + command.getString("op"));
        };
    }

    private static Object binding(RuntimeBindingRecord record) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("bindingId", record.getBindingId());
        value.put("generation", record.getGeneration());
        value.put("state", record.getState().name());
        return value;
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
