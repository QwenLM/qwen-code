package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.StoredResource;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * FG12b (issue #14447): the test-only seam that rejects one step of the MCP
 * record state machine. The wrapper calls it from inside the Session store's
 * commit transaction, before the record is applied, so the whole commit rolls
 * back exactly as a store failure would.
 */
public final class StoreFaultGate {
    public enum Phase {
        INTENT, CONFIGURE_DISPATCH, OPERATION_DISPATCH, SETTLED, RELEASING,
        DRAINED, RELEASED
    }

    public static final StoreFaultGate INSTANCE = new StoreFaultGate();
    private static final ObjectMapper JSON = new ObjectMapper();

    private volatile Phase phase;
    private volatile String target;
    private final AtomicInteger attempts = new AtomicInteger();

    private StoreFaultGate() {
    }

    public void arm(Phase next, String recordId) {
        attempts.set(0);
        target = recordId;
        phase = next;
    }

    public void clear() {
        phase = null;
        target = null;
    }

    public int attempts() {
        return attempts.get();
    }

    void inspect(byte[] recordBytes,
            Function<String, StoredResource> resources) {
        Phase expected = phase;
        if (expected == null) {
            return;
        }
        for (String line : new String(recordBytes, StandardCharsets.UTF_8)
                .split("\n")) {
            JsonNode parsed = parse(line);
            if (parsed == null) {
                continue;
            }
            JsonNode event = parsed.path("managedSession");
            if (!"domain.committed".equals(event.path("kind").asText())) {
                continue;
            }
            JsonNode payload = event.path("payload");
            String domain = payload.path("domain").asText();
            if (!"mcp_configuration".equals(domain)
                    && !"mcp_operation".equals(domain)) {
                continue;
            }
            StoredResource resource = resources.apply(payload.path("recordRef")
                    .path("resourceId").asText());
            JsonNode record = parse(new String(resource.bytes(),
                    StandardCharsets.UTF_8));
            if (!matches(expected, domain, record)) {
                continue;
            }
            attempts.incrementAndGet();
            throw new IllegalStateException(
                    "FG12b store fault injected: " + expected);
        }
    }

    private boolean matches(Phase expected, String domain, JsonNode record) {
        String id = "mcp_configuration".equals(domain)
                ? record.path("configurationId").asText()
                : record.path("operationId").asText();
        if (target != null && !target.equals(id)) {
            return false;
        }
        String execution = record.path("run").path("execution").asText();
        return switch (expected) {
            case INTENT -> "mcp_configuration".equals(domain)
                    && "intent".equals(execution);
            case CONFIGURE_DISPATCH -> "mcp_configuration".equals(domain)
                    && "dispatch_started".equals(execution);
            case OPERATION_DISPATCH -> "mcp_operation".equals(domain)
                    && "dispatch_started".equals(execution);
            case SETTLED -> "mcp_operation".equals(domain)
                    && "settled".equals(execution);
            case RELEASING -> "mcp_configuration".equals(domain)
                    && "releasing".equals(
                            record.path("releaseState").asText());
            case DRAINED -> "mcp_configuration".equals(domain)
                    && "drained".equals(record.path("releaseState").asText());
            case RELEASED -> "mcp_configuration".equals(domain)
                    && "released".equals(
                            record.path("releaseState").asText());
        };
    }

    private static JsonNode parse(String text) {
        try {
            return JSON.readTree(text);
        } catch (IOException error) {
            throw new IllegalStateException(error);
        }
    }
}
