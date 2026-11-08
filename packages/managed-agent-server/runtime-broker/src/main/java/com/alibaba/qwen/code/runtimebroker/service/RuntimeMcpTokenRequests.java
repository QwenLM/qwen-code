package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeMcpTokenIssuer;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;

final class RuntimeMcpTokenRequests {
    private RuntimeMcpTokenRequests() {}

    static Map<String, Object> issue(
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            RuntimeProvisioner provisioner,
            RuntimeMcpTokenIssuer issuer,
            String leaseId,
            String token,
            Map<String, Object> body) {
        if (issuer == null) {
            throw new RuntimeBrokerException(
                    409, "managed_mcp_oauth_unavailable",
                    "Personal MCP authorization is unavailable.", false);
        }
        Set<String> required = Set.of(
                "protocolVersion", "bindingId", "generation", "epoch", "harnessSessionId",
                "configRevision", "serverId", "credentialId", "credentialGeneration",
                "executionActorKey", "resourceUri");
        var allowed = new HashSet<>(required);
        allowed.add("runtimeSessionId");
        if (!body.keySet().containsAll(required) || !allowed.containsAll(body.keySet())
                || !Long.valueOf(1).equals(BrokerValues.exactLong(body.get("protocolVersion")))
                || !(body.get("executionActorKey") instanceof String actor)
                || !actor.matches("[a-f0-9]{64}")) {
            throw invalid("runtime_broker_invalid_request", "Invalid personal MCP token request.");
        }
        long generation = mcpTokenCounter(body.get("generation"), 1);
        long epoch = mcpTokenCounter(body.get("epoch"), 0);
        long configRevision = mcpTokenCounter(body.get("configRevision"), 1);
        long credentialGeneration = mcpTokenCounter(body.get("credentialGeneration"), 1);
        if (!(body.get("resourceUri") instanceof String resource)
                || resource.isBlank() || resource.length() > 4096
                || resource.indexOf('\0') >= 0) {
            throw invalid("runtime_broker_invalid_request", "Invalid personal MCP resource.");
        }
        String bindingId = JsonCodec.requiredString(body, "bindingId", "MCP token");
        RuntimeBindingRecord binding = bindingRepository.findById(bindingId);
        requireMcpTokenLease(binding, generation, leaseId, epoch, token);
        RuntimeScope scope = binding.getRequest().getScope();
        String claimedHarness = JsonCodec.requiredString(body, "harnessSessionId", "MCP token");
        RuntimeSessionRecord runtimeSession = null;
        String harness;
        if (body.containsKey("runtimeSessionId")) {
            String runtimeId = JsonCodec.requiredString(body, "runtimeSessionId", "MCP token");
            runtimeSession = sessionRepository.findHistorical(scope.getTenantId(), claimedHarness, runtimeId);
            if (runtimeSession == null
                    || runtimeSession.getState() != RuntimeSessionRecord.State.READY
                    || !bindingId.equals(runtimeSession.getBindingId())
                    || runtimeSession.getRuntimeGeneration() != generation
                    || !scope.equals(runtimeSession.getSession().getScope())) {
                throw conflict("managed_mcp_owner_unavailable", "The original MCP Runtime Session is unavailable.");
            }
            harness = runtimeSession.getSession().getHarnessSessionId();
        } else if ("session".equals(scope.getIsolationClass())) {
            harness = binding.getRequest().getIsolationKey();
        } else {
            throw conflict("managed_mcp_owner_unavailable", "A shared Runtime needs an original MCP Runtime Session.");
        }
        if (!harness.equals(claimedHarness)) {
            throw conflict("managed_mcp_owner_unavailable", "The MCP Runtime belongs to another Session.");
        }
        bindingRepository.requireHarnessAdmission(binding.getRequest(), scope, harness, null);
        if (!provisioner.isUsable(binding.getLease())) {
            throw conflict("managed_mcp_owner_unavailable", "The original MCP Runtime is unavailable.");
        }
        Map<String, Object> normalized = new LinkedHashMap<>(body);
        normalized.put("configRevision", configRevision);
        normalized.put("credentialGeneration", credentialGeneration);
        String accessToken = issuer.issue(scope, harness, BrokerValues.immutableMap(normalized));
        requireMcpTokenLease(bindingRepository.findById(bindingId), generation, leaseId, epoch, token);
        bindingRepository.requireHarnessAdmission(binding.getRequest(), scope, harness, null);
        if (runtimeSession != null) {
            var current = sessionRepository.findHistorical(
                    scope.getTenantId(), harness, runtimeSession.getRuntimeSessionId());
            if (current == null || !current.sameIdentity(runtimeSession)
                    || current.getState() != RuntimeSessionRecord.State.READY) {
                throw conflict("managed_mcp_owner_unavailable", "The original MCP Runtime Session changed.");
            }
        }
        if (accessToken == null || accessToken.isBlank() || accessToken.length() > 64 * 1024) {
            throw conflict("managed_mcp_oauth_unavailable", "Personal MCP authorization is unavailable.");
        }
        return Map.of("protocolVersion", 1, "accessToken", accessToken);
    }

    private static long mcpTokenCounter(Object value, long minimum) {
        Long parsed = value instanceof String text && text.matches("0|[1-9][0-9]{0,15}")
                ? Long.parseLong(text) : BrokerValues.exactLong(value);
        if (parsed == null || parsed < minimum || parsed > 9_007_199_254_740_991L) {
            throw invalid("runtime_broker_invalid_request", "Invalid personal MCP token generation.");
        }
        return parsed;
    }

    private static void requireMcpTokenLease(
            RuntimeBindingRecord binding, long generation, String leaseId, long epoch, String token) {
        if (binding == null || binding.getGeneration() != generation
                || binding.getState() != RuntimeBindingRecord.State.READY
                || binding.isDrainRequested() || binding.getLease() == null
                || !binding.getLease().getLeaseId().equals(leaseId)
                || binding.getLease().getEpoch() != epoch || token == null
                || !MessageDigest.isEqual(
                        binding.getLease().getToken().getBytes(StandardCharsets.UTF_8),
                        token.getBytes(StandardCharsets.UTF_8))) {
            throw new RuntimeBrokerException(
                    401, "managed_mcp_token_unauthorized",
                    "Original Runtime authentication failed.", false);
        }
    }
}
