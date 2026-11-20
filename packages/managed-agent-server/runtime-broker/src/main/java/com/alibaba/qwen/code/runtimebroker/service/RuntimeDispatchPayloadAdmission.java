package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isProtocolV3;

/**
 * The dispatch payload a placement admits, split out of the Broker facade along
 * the admission seam. The payload is hashed and shape-checked once, against the
 * digest its reservation recorded, and each profile then answers for the Tool
 * family it can actually prove: a refusal that reaches a worker could run a
 * command no drain on that placement could ever account for.
 */
final class RuntimeDispatchPayloadAdmission {
    private final RuntimePublicationVerifier publicationVerifier;
    private final ToolExecutionRepository executionRepository;
    private final Clock clock;

    RuntimeDispatchPayloadAdmission(RuntimePublicationVerifier publicationVerifier,
            ToolExecutionRepository executionRepository, Clock clock) {
        this.publicationVerifier = publicationVerifier;
        this.executionRepository = executionRepository;
        this.clock = clock;
    }

    /**
     * The admitted payload and its verified classification. A profile refusal
     * settles the PREPARED row and reports {@code refused} instead, so the caller
     * answers that record rather than dispatching; its own settle may answer null
     * when the row moved on, which the caller re-reads.
     */
    record Admitted(Map<String, Object> payload, VerifiedDispatchPayload verified,
            boolean refused, ToolExecutionRecord settled) {
    }

    Admitted admit(SessionContext context, ToolExecutionRecord record,
            boolean v3, String payloadJson) {
        // The UTF-8 encoder would turn an unpaired surrogate into '?'.
        if (payloadJson == null || !BrokerValues.isWellFormedJson(payloadJson)) {
            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
        }
        byte[] bytes = payloadJson.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > 256 * 1024) {
            throw invalid("runtime_payload_invalid", "Tool payload exceeds 256 KiB");
        }
        String digest = "sha256:" + DigestUtils.sha256Hex(bytes);
        if (!digest.equals(record.getRequestDigest())) {
            throw conflict("runtime_idempotency_conflict", "Tool payload differs from its reserved digest");
        }
        Map<String, Object> payload = JsonCodec.parseObject(bytes, "tool payload");
        // An escaped unpaired surrogate passes the text check above but
        // would still reach the Worker, and run, as '?'.
        if (!payload.keySet().equals(Set.of("toolName", "input"))
                || !(payload.get("toolName") instanceof String toolName) || toolName.isEmpty()
                || !(payload.get("input") instanceof Map)
                || !BrokerValues.isWellFormedJson(payload)
                || isProtocolV3(record.getReference())
                    && !"run_shell_command".equals(toolName) && !"monitor".equals(toolName)) {
            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
        }
        // The digest was just computed and compared to the receipt and the
        // payload parsed and shape-checked above; classify from those locals
        // instead of hashing and parsing the same bytes a second time.
        VerifiedDispatchPayload verifiedPayload =
                VerifiedDispatchPayload.of(digest, toolName);
        if (WorkspaceExecutionProfile.isExternalShellRequest(context.binding().getRequest())) {
            // The external foreground-Shell lane admits exactly one Tool v3
            // family member. Background Shell and Monitor keep their own
            // ledgers and holds, which this placement's single-worker drain
            // cannot prove.
            Map<?, ?> shellInput = payload.get("input") instanceof Map<?, ?> value
                    ? value : Map.of();
            if (!v3 || record.getReference().containsKey("runtimeProtocol")
                    || !"run_shell_command".equals(toolName)
                    || shellInput.containsKey("is_background")
                    || shellInput.containsKey("is_monitor")
                    || publicationVerifier == null
                    || publicationVerifier.externalShell() == null) {
                Map<String, Object> refusal = new LinkedHashMap<>();
                refusal.put("executionStatus", "not_started");
                refusal.put("responseParts", List.of());
                refusal.put("capture", null);
                refusal.put("error", Map.of("type", "workspace_tool_unsupported",
                        "message", "External Shell requires a foreground Tool v3 Shell payload"));
                executionRepository.settlePrepared(record, refusal, clock.instant());
                throw invalid("runtime_payload_invalid",
                        "External Shell requires a foreground Tool v3 Shell payload");
            }
        } else if (WorkspaceExecutionProfile.isExternalWorkspaceRequest(context.binding().getRequest())
                && (v3 || record.getReference().containsKey("runtimeProtocol")
                        || !Set.of("read_file", "write_file", "edit", "glob").contains(toolName))) {
            executionRepository.settlePrepared(record, Map.of(
                    "executionStatus", "not_started", "responseParts", List.of(),
                    "error", Map.of("type", "workspace_tool_unsupported",
                            "message", "External Workspace requires a file Tool v2 payload")), clock.instant());
            throw invalid("runtime_payload_invalid", "External Workspace requires a file Tool v2 payload");
        }
        return new Admitted(payload, verifiedPayload, false, null);
    }
}
