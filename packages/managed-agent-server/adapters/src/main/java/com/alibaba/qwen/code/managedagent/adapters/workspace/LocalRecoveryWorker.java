package com.alibaba.qwen.code.managedagent.adapters.workspace;

import com.alibaba.qwen.code.managedagent.contracts.workspace.RecoveryWorker;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol;
import com.alibaba.qwen.code.runtimebroker.host.RuntimeStateFiles;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedInputStream;
import java.io.BufferedWriter;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.function.BiFunction;

import static com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.check;
import static com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceRecoveryProtocol.text;
public final class LocalRecoveryWorker implements RecoveryWorker {
    private static final ObjectMapper JSON = new ObjectMapper();

    public void execute(JsonNode request, Session store,
            BiFunction<String, JsonNode, JsonNode> calls) throws Exception {
        var command = new ProcessBuilder(text(request, "nodeExecutable"), text(request, "cliEntry"),
                "--workspace-recovery-worker").redirectError(ProcessBuilder.Redirect.INHERIT);
        command.environment().keySet().removeIf(key -> key.startsWith("W1_") || key.startsWith("OSS_"));
        Process worker;
        try {
            worker = command.start();
        } catch (IOException error) {
            store.workerFailed();
            throw error;
        }
        try (var output = new BufferedInputStream(worker.getInputStream());
                var replies = new BufferedWriter(new OutputStreamWriter(worker.getOutputStream(), StandardCharsets.UTF_8))) {
            long lastId = 0;
            byte[] line;
            while ((line = message(output)) != null) {
                JsonNode call = WorkspaceRecoveryProtocol.parse(line);
                long callId = WorkspaceRecoveryProtocol.positive(call, "id");
                check(callId == lastId + 1, "worker_protocol_error");
                lastId = callId;
                ObjectNode response = JSON.createObjectNode().put("id", callId);
                try {
                    response.set("result", calls.apply(text(call, "method"), call.path("params")));
                } catch (RuntimeException error) {
                    String code = error instanceof WorkspaceRecoveryProtocol.RecoveryFailure failure
                            ? failure.code : "recovery_read_failed";
                    if (!(error instanceof WorkspaceRecoveryProtocol.RecoveryFailure)) {
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

    private static byte[] message(InputStream input) throws IOException {
        var bytes = new ByteArrayOutputStream();
        int next;
        while ((next = input.read()) != -1 && next != '\n') {
            check(bytes.size() < 16 * 1024 * 1024, "worker_message_too_large");
            bytes.write(next);
        }
        check(next != -1 || bytes.size() == 0, "worker_protocol_error");
        return next == -1 ? null : bytes.toByteArray();
    }

    public void validateStateDirectory(Path directory) throws IOException {
        RuntimeStateFiles.validateDirectory(directory);
    }
}
