package com.alibaba.qwen.code.daemon;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Prompt content plus daemon and local observation deadlines. */
public final class PromptRequest {
    private static final long MAX_DAEMON_DEADLINE_MILLIS = Integer.MAX_VALUE;

    private final List<Map<String, Object>> content;
    private final Long deadlineMillis;
    private final Duration observationTimeout;

    private PromptRequest(List<Map<String, Object>> content,
            Long deadlineMillis, Duration observationTimeout) {
        List<Map<String, Object>> immutableContent = new ArrayList<>();
        for (Map<String, Object> block : content) {
            immutableContent.add(JsonSupport.immutableObject(block));
        }
        this.content = Collections.unmodifiableList(immutableContent);
        this.deadlineMillis = deadlineMillis;
        this.observationTimeout = observationTimeout;
    }

    public static PromptRequest text(String text) {
        if (text == null || text.isEmpty()) {
            throw new IllegalArgumentException("text must not be empty");
        }
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("type", "text");
        block.put("text", text);
        return new PromptRequest(Collections.singletonList(block), null, null);
    }

    public static Builder builder() {
        return new Builder();
    }

    public PromptRequest withObservationTimeout(Duration timeout) {
        validateDuration(timeout, "observationTimeout");
        return new PromptRequest(new ArrayList<>(content), deadlineMillis, timeout);
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("prompt", content);
        if (deadlineMillis != null) {
            result.put("deadlineMs", deadlineMillis);
        }
        return result;
    }

    Duration observationTimeoutOr(Duration fallback) {
        return observationTimeout == null ? fallback : observationTimeout;
    }

    public List<Map<String, Object>> getContent() {
        return content;
    }

    public Long getDeadlineMillis() {
        return deadlineMillis;
    }

    public Duration getObservationTimeout() {
        return observationTimeout;
    }

    private static void validateDuration(Duration duration, String name) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
    }

    public static final class Builder {
        private final List<Map<String, Object>> content = new ArrayList<>();
        private Long deadlineMillis;
        private Duration observationTimeout;

        private Builder() {
        }

        public Builder addText(String text) {
            if (text == null || text.isEmpty()) {
                throw new IllegalArgumentException("text must not be empty");
            }
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("type", "text");
            block.put("text", text);
            content.add(block);
            return this;
        }

        public Builder addContent(Map<String, Object> block) {
            if (block == null || block.isEmpty()) {
                throw new IllegalArgumentException("content block must not be empty");
            }
            content.add(JsonSupport.immutableObject(block));
            return this;
        }

        public Builder deadline(Duration deadline) {
            validateDuration(deadline, "deadline");
            try {
                this.deadlineMillis = deadline.toMillis();
            } catch (ArithmeticException e) {
                throw new IllegalArgumentException(
                        "deadline is outside the millisecond range", e);
            }
            if (deadlineMillis <= 0) {
                throw new IllegalArgumentException("deadline must be at least one millisecond");
            }
            if (deadlineMillis > MAX_DAEMON_DEADLINE_MILLIS) {
                throw new IllegalArgumentException(
                        "deadline must not exceed 2147483647 milliseconds");
            }
            return this;
        }

        public Builder observationTimeout(Duration observationTimeout) {
            validateDuration(observationTimeout, "observationTimeout");
            this.observationTimeout = observationTimeout;
            return this;
        }

        public PromptRequest build() {
            if (content.isEmpty()) {
                throw new IllegalStateException("at least one content block is required");
            }
            return new PromptRequest(new ArrayList<>(content), deadlineMillis,
                    observationTimeout);
        }
    }
}
