package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
public final class WorkspaceRecoveryProtocol {
    private WorkspaceRecoveryProtocol() { }
    private static final ObjectMapper JSON = new ObjectMapper();
    public static JsonNode parse(String text) {
        return parse(text.getBytes(StandardCharsets.UTF_8));
    }

    public static JsonNode parse(byte[] bytes) {
        check(bytes.length <= 16 * 1024 * 1024, "message_too_large");
        return ToolPublicationContract.readJson(bytes);
    }

    public static String text(JsonNode node, String field) {
        JsonNode value = node.path(field);
        check(value.isTextual() && !value.asText().isEmpty() && value.asText().length() <= 8192, "invalid_request");
        return value.asText();
    }

    public static long positive(JsonNode node, String field) {
        JsonNode value = node.path(field);
        check(value.isIntegralNumber() && value.canConvertToLong() && value.asLong() > 0
                && value.asLong() <= ManagedSessionStoreModels.MAX_SAFE_COUNTER, "invalid_request");
        return value.asLong();
    }

    public static String uuid(JsonNode node, String field) {
        String value = text(node, field);
        try {
            check(UUID.fromString(value).toString().equals(value), "invalid_request");
        } catch (IllegalArgumentException error) {
            throw failure("invalid_request");
        }
        return value;
    }

    public static String hash(String value) {
        return hash(value.getBytes(StandardCharsets.UTF_8));
    }

    public static String hash(byte[] bytes) {
        return HexFormat.of().formatHex(digest().digest(bytes));
    }

    public static MessageDigest digest() {
        try {
            return DigestUtils.getSha256Digest();
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(error);
        }
    }

    public static void check(boolean condition, String code) {
        if (!condition) {
            throw failure(code);
        }
    }

    // The deepest cause is not the verdict: a structural refusal keeps its
    // service code even when the discarded I/O cause sits deeper in the chain.
    public static String errorCode(Throwable error) {
        for (Throwable current = error; current != null && current != current.getCause();
                current = current.getCause()) {
            if (current instanceof RecoveryFailure failure) {
                return failure.code;
            }
            if (current instanceof RuntimeBrokerException failure) {
                return failure.getCode();
            }
        }
        return "migration_failed";
    }

    public static RecoveryFailure failure(String code) {
        return new RecoveryFailure(code);
    }

    public static final class RecoveryFailure extends IllegalStateException {
        public final String code;
        public RecoveryFailure(String code) {
            super("Workspace recovery: " + code);
            this.code = code;
        }
    }
}
