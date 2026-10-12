package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.JSON;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.check;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.text;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.aliyun.oss.ClientBuilderConfiguration;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.common.auth.CredentialsProviderFactory;
import com.aliyun.oss.common.comm.SignVersion;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.BufferedInputStream;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;

/** Private offline entry; it never boots the application or a Runtime. */
public final class WorkspaceRecoveryMain {
    private WorkspaceRecoveryMain() {
    }

    public static void main(String[] args) throws Exception {
        check(args.length >= 2 && Set.of("capture", "verify", "inspect").contains(args[0])
                && ("inspect".equals(args[0]) ? args.length == 2
                        : args.length == 3 && "--offline-confirmed".equals(args[2])), "invalid_arguments");
        Path input = Path.of(args[1]);
        check(Files.isRegularFile(input, LinkOption.NOFOLLOW_LINKS) && Files.size(input) <= 1024 * 1024,
                "invalid_request_file");
        byte[] bytes = Files.readAllBytes(input);
        JsonNode request = WorkspaceRecoveryStore.parse(bytes);
        OSS oss = null;
        // The private RPC loop is single-threaded; transactions still commit separately.
        try (var source = new SingleConnectionDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"),
                requiredPresent("W1_JDBC_PASSWORD"), true)) {
            var jdbc = new JdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            var properties = new ManagedAgentProperties();
            properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
            if (!"inspect".equals(args[0])) {
                properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                        new WorkspaceMount(text(request, "tenantId"), text(request, "storageId"), text(request, "sourceRoot"))));
            }
            ToolPublicationObjectStore objects = null;
            if ("capture".equals(args[0]) && System.getenv("W1_OSS_ENDPOINT") != null) {
                URI endpoint = URI.create(required("W1_OSS_ENDPOINT"));
                String region = required("W1_OSS_REGION");
                check("https".equals(endpoint.getScheme()) && ("oss-" + region + ".aliyuncs.com").equals(endpoint.getHost())
                        && (endpoint.getRawPath() == null || endpoint.getRawPath().isEmpty())
                        && endpoint.getRawQuery() == null && endpoint.getRawUserInfo() == null, "invalid_oss_endpoint");
                var settings = new ClientBuilderConfiguration();
                settings.setSignatureVersion(SignVersion.V4);
                oss = OSSClientBuilder.create().endpoint(endpoint.toString()).region(region)
                        .credentialsProvider(CredentialsProviderFactory.newEnvironmentVariableCredentialsProvider())
                        .clientConfiguration(settings).build();
                objects = new AliyunToolPublicationObjectStore(oss, required("W1_OSS_BUCKET"));
            }
            var store = new WorkspaceRecoveryStore(jdbc, manager, new WorkspaceStorageGuard(jdbc, manager, properties),
                    objects, args[0], bytes);
            JsonNode existing = store.inspect();
            if ("inspect".equals(args[0]) || Set.of("SEALED", "VERIFIED").contains(existing.path("state").asText())) {
                System.out.println(existing);
                return;
            }
            executeWorker(request, store, store::call);
            System.out.println(store.inspect());
        } finally {
            if (oss != null) {
                oss.shutdown();
            }
        }
    }

    public static void executeWorker(JsonNode request, WorkspaceRecoveryStore store,
            java.util.function.BiFunction<String, JsonNode, JsonNode> calls) throws Exception {
        var command = new ProcessBuilder(text(request, "nodeExecutable"), text(request, "cliEntry"),
                "--workspace-recovery-worker").redirectError(ProcessBuilder.Redirect.INHERIT);
        command.environment().keySet().removeIf(key -> key.startsWith("W1_") || key.startsWith("OSS_"));
        Process worker;
        try {
            worker = command.start();
        } catch (java.io.IOException error) {
            store.workerFailed();
            throw error;
        }
        try (var output = new BufferedInputStream(worker.getInputStream());
                var replies = new BufferedWriter(new OutputStreamWriter(worker.getOutputStream(), StandardCharsets.UTF_8))) {
            long lastId = 0;
            byte[] line;
            while ((line = message(output)) != null) {
                JsonNode call = WorkspaceRecoveryStore.parse(line);
                long callId = WorkspaceRecoveryStore.positive(call, "id");
                check(callId == lastId + 1, "worker_protocol_error");
                lastId = callId;
                ObjectNode response = JSON.createObjectNode().put("id", callId);
                try {
                    response.set("result", calls.apply(text(call, "method"), call.path("params")));
                } catch (RuntimeException error) {
                    String code = error instanceof WorkspaceRecoveryStore.RecoveryFailure failure
                            ? failure.code : "recovery_read_failed";
                    if (!(error instanceof WorkspaceRecoveryStore.RecoveryFailure)) {
                        store.workerFailed();
                    }
                    response.putObject("error").put("code", code).put("message", "Workspace recovery: " + code);
                }
                replies.write(response.toString());
                replies.newLine();
                replies.flush();
            }
            check(worker.waitFor(30, TimeUnit.SECONDS) && worker.exitValue() == 0, "worker_failed");
            JsonNode receipt = store.inspect();
            check(Set.of("SEALED", "VERIFIED").contains(receipt.path("state").asText()), "worker_incomplete");
        } catch (Exception error) {
            store.workerFailed();
            throw error;
        } finally {
            if (worker.isAlive()) {
                worker.destroyForcibly();
            }
        }
    }

    private static byte[] message(InputStream input) throws java.io.IOException {
        var bytes = new ByteArrayOutputStream();
        int next;
        while ((next = input.read()) != -1 && next != '\n') {
            check(bytes.size() < 16 * 1024 * 1024, "worker_message_too_large");
            bytes.write(next);
        }
        check(next != -1 || bytes.size() == 0, "worker_protocol_error");
        return next == -1 ? null : bytes.toByteArray();
    }

    private static String required(String name) {
        String value = requiredPresent(name);
        check(!value.isBlank(), "missing_environment");
        return value;
    }

    private static String requiredPresent(String name) {
        String value = System.getenv(name);
        check(value != null, "missing_environment");
        return value;
    }
}
