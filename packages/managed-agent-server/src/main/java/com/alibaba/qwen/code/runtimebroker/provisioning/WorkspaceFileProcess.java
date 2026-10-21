package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.time.Duration;
import java.util.List;
import java.util.Map;

/** Bounded, read-only bootstrap exchange using the configured local CLI. */
public final class WorkspaceFileProcess {
    private WorkspaceFileProcess() {
    }

    public static Map<String, Object> read(String node, String entry, Map<String, Object> request) {
        if (node == null || node.isBlank() || entry == null || entry.isBlank()) {
            throw unsupported();
        }
        byte[] input = JsonCodec.encode(request);
        if (input.length > 65536) {
            throw unsupported();
        }
        var help = SshConnectionManager.runCommand(List.of(node, entry, "managed-runtime-bootstrap", "--help"),
                new byte[]{'{', '}'}, Duration.ofSeconds(15));
        requireCapability(help);
        var exchange = SshConnectionManager.runCommand(List.of(node, entry, "managed-runtime-bootstrap"),
                input, Duration.ofSeconds(15));
        if (exchange.exitCode() != 0 || exchange.stdout().length > 65536) {
            throw unsupported();
        }
        Map<String, Object> envelope;
        try {
            envelope = JsonCodec.parseObject(exchange.stdout(), "Workspace file response");
        } catch (IllegalArgumentException error) {
            throw unsupported();
        }
        if (Long.valueOf(1).equals(BrokerValues.exactLong(envelope.get("protocolVersion")))
                && Boolean.TRUE.equals(envelope.get("ok")) && envelope.get("result") instanceof Map<?, ?> result) {
            return JsonCodec.parseObject(JsonCodec.encode(result), "Workspace file result");
        }
        throw new RuntimeBrokerException(409, "workspace_file_unavailable", "Workspace file cannot be read.", false);
    }

    public static RuntimeBrokerException unsupported() {
        return new RuntimeBrokerException(409, "workspace_files_unsupported", "Workspace file access requires an updated CLI.", false);
    }

    static void requireCapability(SshConnectionManager.CommandResult help) {
        try {
            if (help.exitCode() != 0 || help.stdout().length > 65536) {
                throw unsupported();
            }
            var document = JsonCodec.parseObject(help.stdout(), "Workspace file capability");
            if (!Long.valueOf(1).equals(BrokerValues.exactLong(document.get("protocolVersion")))
                    || !(document.get("capabilities") instanceof Map<?, ?> capabilities)
                    || !Long.valueOf(1).equals(BrokerValues.exactLong(capabilities.get("workspaceFiles")))) {
                throw unsupported();
            }
        } catch (RuntimeException error) {
            throw unsupported();
        }
    }
}
