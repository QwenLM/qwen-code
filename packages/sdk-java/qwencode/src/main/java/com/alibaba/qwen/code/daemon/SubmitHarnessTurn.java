package com.alibaba.qwen.code.daemon;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Caller-owned prompt admission request for a Hosted Harness session. */
public final class SubmitHarnessTurn {
    private static final long MAXIMUM_DEADLINE_MILLIS = Integer.MAX_VALUE;

    private final HarnessSessionRef session;
    private final String promptId;
    private final List<Map<String, Object>> promptContent;
    private final String payloadDigest;
    private final Long deadlineMillis;

    private SubmitHarnessTurn(Builder builder) {
        if (builder.session == null) {
            throw new IllegalStateException("session must be provided");
        }
        if (builder.promptContent.isEmpty()) {
            throw new IllegalStateException(
                    "at least one prompt content block is required");
        }
        this.session = builder.session;
        this.promptId = HostedHarnessClient.requireUuid(
                builder.promptId, "promptId");
        List<Map<String, Object>> content = new ArrayList<>();
        for (Map<String, Object> block : builder.promptContent) {
            content.add(JsonSupport.immutableObject(block));
        }
        this.promptContent = Collections.unmodifiableList(content);
        this.payloadDigest = HostedHarnessClient.requireDigest(
                builder.payloadDigest, "payloadDigest");
        String computed = computePayloadDigest(this.promptContent);
        if (!computed.equals(payloadDigest)) {
            throw new IllegalArgumentException(
                    "payloadDigest does not match promptContent");
        }
        this.deadlineMillis = builder.deadlineMillis;
    }

    public static Builder builder() {
        return new Builder();
    }

    public static String computePayloadDigest(
            List<Map<String, Object>> promptContent) {
        if (promptContent == null || promptContent.isEmpty()) {
            throw new IllegalArgumentException(
                    "promptContent must not be empty");
        }
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = JsonSupport.encode(promptContent)
                    .getBytes(StandardCharsets.UTF_8);
            byte[] hashed = digest.digest(bytes);
            StringBuilder result = new StringBuilder("sha256:");
            for (byte value : hashed) {
                result.append(String.format("%02x", value & 0xff));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    HarnessSessionRef getSession() {
        return session;
    }

    String getPromptId() {
        return promptId;
    }

    String getPayloadDigest() {
        return payloadDigest;
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("prompt", promptContent);
        result.put("promptId", promptId);
        result.put("payloadDigest", payloadDigest);
        if (deadlineMillis != null) {
            result.put("deadlineMs", deadlineMillis);
        }
        return result;
    }

    public static final class Builder {
        private HarnessSessionRef session;
        private String promptId;
        private final List<Map<String, Object>> promptContent =
                new ArrayList<>();
        private String payloadDigest;
        private Long deadlineMillis;

        private Builder() {
        }

        public Builder session(HarnessSessionRef session) {
            this.session = session;
            return this;
        }

        public Builder promptId(String promptId) {
            this.promptId = promptId;
            return this;
        }

        public Builder addText(String text) {
            if (text == null || text.isEmpty()) {
                throw new IllegalArgumentException("text must not be empty");
            }
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("type", "text");
            block.put("text", text);
            promptContent.add(block);
            return this;
        }

        public Builder addContent(Map<String, Object> block) {
            if (block == null || block.isEmpty()) {
                throw new IllegalArgumentException(
                        "content block must not be empty");
            }
            promptContent.add(JsonSupport.immutableObject(block));
            return this;
        }

        public Builder payloadDigest(String payloadDigest) {
            this.payloadDigest = payloadDigest;
            return this;
        }

        public Builder deadline(Duration deadline) {
            if (deadline == null || deadline.isZero()
                    || deadline.isNegative()) {
                throw new IllegalArgumentException(
                        "deadline must be positive");
            }
            long millis;
            try {
                millis = deadline.toMillis();
            } catch (ArithmeticException e) {
                throw new IllegalArgumentException(
                        "deadline is outside the millisecond range", e);
            }
            if (millis <= 0 || millis > MAXIMUM_DEADLINE_MILLIS) {
                throw new IllegalArgumentException(
                        "deadline must be between 1 and 2147483647 milliseconds");
            }
            this.deadlineMillis = millis;
            return this;
        }

        public SubmitHarnessTurn build() {
            return new SubmitHarnessTurn(this);
        }
    }
}
