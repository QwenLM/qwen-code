package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

/**
 * FG12b/FG13b (issues #14447/#14449): the test-only seam that rejects one step
 * of the MCP or Hook record state machine. The wrapper calls it from inside
 * the Session store's commit transaction, before the record is applied, so the
 * whole commit rolls back exactly as a store failure would.
 *
 * <p>FG13a adds the acknowledgement-loss mode: the same phase is matched from
 * the faulting store's after-commit callback, so the commit lands and only the
 * caller's receipt is lost.
 */
public final class StoreFaultGate {
    public enum Phase {
        INTENT, CONFIGURE_DISPATCH, OPERATION_DISPATCH, SETTLED, RELEASING,
        DRAINED, RELEASED,
        HOOK_INTENT, HOOK_DISPATCH_STARTED, HOOK_SETTLED, HOOK_PLAN_SETTLED,
        HOOK_REGISTRATION_SETTLED
    }

    public static final StoreFaultGate INSTANCE = new StoreFaultGate();
    private static final ObjectMapper JSON = new ObjectMapper();

    private volatile Phase phase;
    private volatile String target;
    private volatile boolean loseAck;
    private final AtomicInteger attempts = new AtomicInteger();

    private StoreFaultGate() {
    }

    public void arm(Phase next, String recordId) {
        attempts.set(0);
        target = recordId;
        loseAck = false;
        phase = next;
    }

    /**
     * FG13a: land the commit first and only then report the failure, so the
     * caller sees a lost acknowledgement over a durable record.
     */
    public void armAck(Phase next, String recordId) {
        arm(next, recordId);
        loseAck = true;
    }

    public void clear() {
        phase = null;
        target = null;
        loseAck = false;
    }

    public int attempts() {
        return attempts.get();
    }

    /** FG13a: the fault is owed to the transaction's after-commit callback. */
    boolean ackArmed() {
        return loseAck && phase != null;
    }

    void inspect(byte[] recordBytes,
            Function<String, StoredResource> resources) {
        if (!loseAck) {
            fault(recordBytes, resources, "Store fault injected: ");
        }
    }

    void afterApply(byte[] recordBytes,
            Function<String, StoredResource> resources) {
        if (loseAck) {
            fault(recordBytes, resources, "Store ack lost: ");
        }
    }

    private void fault(byte[] recordBytes,
            Function<String, StoredResource> resources, String message) {
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
                    && !"mcp_operation".equals(domain)
                    && !"hook_execution".equals(domain)
                    && !"hook_registration".equals(domain)) {
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
            throw new IllegalStateException(message + expected);
        }
    }

    private boolean matches(Phase expected, String domain, JsonNode record) {
        String id = switch (domain) {
            case "mcp_configuration" -> record.path("configurationId").asText();
            case "mcp_operation" -> record.path("operationId").asText();
            case "hook_registration" ->
                    record.path("registrationId").asText();
            default -> record.path("hookExecutionId").asText();
        };
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
            case HOOK_INTENT -> "hook_execution".equals(domain)
                    && "intent".equals(execution)
                    && !"__plan__".equals(record.path("hookId").asText());
            case HOOK_DISPATCH_STARTED -> "hook_execution".equals(domain)
                    && "dispatch_started".equals(execution)
                    && !"__plan__".equals(record.path("hookId").asText());
            case HOOK_SETTLED -> "hook_execution".equals(domain)
                    && "settled".equals(execution)
                    && !"__plan__".equals(record.path("hookId").asText());
            case HOOK_PLAN_SETTLED -> "hook_execution".equals(domain)
                    && "settled".equals(execution)
                    && "__plan__".equals(record.path("hookId").asText())
                    && "PreToolUse".equals(
                            record.path("eventName").asText());
            case HOOK_REGISTRATION_SETTLED ->
                    "hook_registration".equals(domain)
                            && "settled".equals(record.path("run")
                                    .path("state").asText());
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
