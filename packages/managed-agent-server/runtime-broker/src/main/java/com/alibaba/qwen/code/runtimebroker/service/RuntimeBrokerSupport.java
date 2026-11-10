package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.StoreFailureException;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import com.alibaba.qwen.code.runtimebroker.protocol.ProviderRuntimeProtocol;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;

import java.time.Duration;
import java.util.concurrent.TimeoutException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

final class RuntimeBrokerSupport {
    private RuntimeBrokerSupport() { }

    static final Set<String> RUNTIME_STATUS_STATES = Set.of(
            "prepared", "executing", "cancel_requested", "settled",
            "unknown");
    static final int MAX_CAS_ATTEMPTS = 16;

    static void requireSameSession(RuntimeSession actual,
            RuntimeSession requested) {
        if (!actual.getHarnessSessionId().equals(
                requested.getHarnessSessionId())
                || !actual.getTurnKind().equals(requested.getTurnKind())
                || !actual.getScope().equals(requested.getScope())) {
            throw conflict("runtime_session_conflict",
                    "runtimeSessionId belongs to another Session identity");
        }
    }

    static <T> CompletionStage<T> safeStage(
            Supplier<CompletionStage<T>> supplier) {
        try {
            CompletionStage<T> stage = supplier.get();
            if (stage == null) {
                return failed(new IllegalStateException(
                        "operation returned no CompletionStage"));
            }
            return stage;
        } catch (RuntimeException | Error exception) {
            return failed(exception);
        }
    }

    static <T> CompletionStage<T> mapFailure(
            CompletionStage<T> stage, String code, String message) {
        return stage.handle((value, error) -> {
            if (error == null) {
                return value;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException) {
                throw new CompletionException(cause);
            }
            throw new CompletionException(
                    unavailable(code, message, cause));
        });
    }

    /**
     * Only a genuine store outage maps to a retryable 503 here: client-input
     * errors, permanent invariant violations, and JVM errors keep the
     * non-retryable mapping the HTTP layer gives them.
     */
    static <T> CompletionStage<T> mapStoreFailure(
            CompletionStage<T> stage) {
        return stage.handle((value, error) -> {
            if (error == null) {
                return value;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException) {
                throw new CompletionException(cause);
            }
            if (cause instanceof StoreFailureException) {
                throw new CompletionException(unavailable(
                        "runtime_broker_store_unavailable",
                        "Managed Runtime execution store is unavailable.",
                        cause));
            }
            throw new CompletionException(cause);
        });
    }

    static boolean workerRefusedRelease(Throwable error) {
        Throwable cause = unwrap(error);
        return cause instanceof RuntimeBrokerException failure
                && ("managed_runtime_owner_hold_pending".equals(failure.getCode())
                        || "managed_runtime_release_timeout".equals(failure.getCode()));
    }

    static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    static <T> CompletableFuture<T> failed(Throwable error) {
        return CompletableFuture.failedFuture(error);
    }

    static RuntimeBrokerException invalid(String code,
            String message) {
        return new RuntimeBrokerException(400, code, message, false);
    }

    static RuntimeBrokerException notFound(String code,
            String message) {
        return new RuntimeBrokerException(404, code, message, false);
    }

    static RuntimeBrokerException conflict(String code,
            String message) {
        return new RuntimeBrokerException(409, code, message, false);
    }

    static RuntimeBrokerException conflict(String code,
            String message, Throwable cause) {
        return new RuntimeBrokerException(409, code, message, false, cause);
    }

    static RuntimeBrokerException unavailable(String code,
            String message) {
        return new RuntimeBrokerException(503, code, message, true);
    }

    static RuntimeBrokerException unavailable(String code,
            String message, Throwable cause) {
        return new RuntimeBrokerException(503, code, message, true, cause);
    }

    static String referenceString(Map<String, Object> reference,
            String field) {
        Object value = reference == null ? null : reference.get(field);
        if (!(value instanceof String)) {
            throw invalid("runtime_reference_invalid",
                    "reference " + field + " is required");
        }
        try {
            return BrokerValues.requireWellFormed(BrokerValues.requireId(
                    (String) value, "reference." + field),
                    "reference." + field);
        } catch (IllegalArgumentException exception) {
            throw invalid("runtime_reference_invalid",
                    "reference " + field + " is invalid");
        }
    }

    static Map<String, Object> immutableMap(Object value,
            String name) {
        if (!(value instanceof Map<?, ?>)) {
            throw invalid("runtime_payload_invalid",
                    name + " must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, ?> source = (Map<String, ?>) value;
        try {
            return BrokerValues.immutableMap(source);
        } catch (IllegalArgumentException exception) {
            throw invalid("runtime_payload_invalid",
                    name + " is invalid");
        }
    }

    static Map<String, Object> runtimeMap(Object value,
            String name) {
        if (!(value instanceof Map<?, ?>)) {
            throw unavailable("runtime_execution_cancel_failed",
                    name + " must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, ?> source = (Map<String, ?>) value;
        try {
            return BrokerValues.immutableMap(source);
        } catch (IllegalArgumentException exception) {
            throw unavailable("runtime_execution_cancel_failed",
                    name + " is invalid", exception);
        }
    }

    static Map<String, Object> projectV3Status(Map<String, Object> response) {
        Object state = response.get("state");
        if (!(state instanceof String name) || !RUNTIME_STATUS_STATES.contains(name)
                || "settled".equals(name) != (response.get("result") instanceof Map)) {
            throw conflict("runtime_execution_conflict", "Tool v3 returned an invalid status");
        }
        return "settled".equals(name)
                ? Map.of("state", name, "result", response.get("result"))
                : Map.of("state", name);
    }

    static CompletionStage<HarnessSessionResolver.Capabilities> resolveCapabilities(
            HarnessSessionResolver sessionResolver, String harnessSessionId, RuntimeLifecycleAuthority authority) {
        String id = BrokerValues.requirePathSafe(BrokerValues.requireId(harnessSessionId, "harnessSessionId"), "harnessSessionId");
        return mapFailure(safeStage(() -> sessionResolver.resolveCapabilities(id, authority)),
                "runtime_scope_resolution_failed", "Runtime scope resolution failed").thenApply(value -> {
                    if (value == null || value.scope() == null) {
                        throw unavailable("runtime_scope_resolution_failed", "Runtime scope resolver returned no scope");
                    }
                    return value;
                });
    }

    static CompletionStage<RuntimeScope> resolveScope(HarnessSessionResolver sessionResolver,
            String harnessSessionId, boolean admission,
            RuntimeLifecycleAuthority authority) {
        return mapFailure(safeStage(
                () -> admission
                        ? sessionResolver.resolveAdmission(harnessSessionId,
                                authority)
                        : sessionResolver.resolve(harnessSessionId, authority)),
                "runtime_scope_resolution_failed",
                "Runtime scope resolution failed").thenApply(scope -> {
                    if (scope == null) {
                        throw unavailable("runtime_scope_resolution_failed",
                                "Runtime scope resolver returned no scope");
                    }
                    return scope;
                });
    }

    static void requireOpen(AtomicBoolean closed) {
        if (closed.get()) {
            throw new IllegalStateException("Runtime Broker is closed");
        }
    }

    static boolean sameReceipt(Map<String, Object> expected,
            Map<String, Object> actual) {
        if (actual == null || !actual.keySet().equals(Set.of("executionCallId", "manifest",
                "deliveryStatus", "historyRevision"))
                || !Objects.equals(expected.get("executionCallId"), actual.get("executionCallId"))
                || !Objects.equals(expected.get("deliveryStatus"), actual.get("deliveryStatus"))) {
            return false;
        }
        Object leftRevision = expected.get("historyRevision");
        Object rightRevision = actual.get("historyRevision");
        if (leftRevision == null ? rightRevision != null
                : !(rightRevision instanceof Number number)
                        || ((Number) leftRevision).longValue() != number.longValue()) {
            return false;
        }
        Object left = expected.get("manifest");
        Object right = actual.get("manifest");
        if (left == null || right == null) {
            return left == right;
        }
        if (!(left instanceof Map<?, ?> saved) || !(right instanceof Map<?, ?> received)
                || !saved.keySet().equals(received.keySet())) {
            return false;
        }
        for (String field : List.of("resourceId", "kind", "digest")) {
            if (!Objects.equals(saved.get(field), received.get(field))) {
                return false;
            }
        }
        for (String field : List.of("schemaVersion", "byteLength")) {
            if (!(saved.get(field) instanceof Number a) || !(received.get(field) instanceof Number b)
                    || a.longValue() != b.longValue()) {
                return false;
            }
        }
        return true;
    }

    static Map<String, Object> sshNoStartReceipt(RuntimeBindingRecord binding, ToolExecutionRecord execution) {
        if (!RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind())
                || !execution.isSettled() || !"not_started".equals(execution.getExecutionStatus())
                || execution.getResult() == null || !execution.getResult().containsKey("capture")
                || execution.getResult().get("capture") != null
                || !(Integer.valueOf(3).equals(execution.getReference().get("runtimeProtocol"))
                        || "deferred_v3".equals(execution.getReference().get("dispatchMode")))
                || ProviderRuntimeProtocol.isReference(execution.getReference())) {
            return null;
        }
        Map<String, Object> receipt = new LinkedHashMap<>();
        receipt.put("executionCallId", execution.getExecutionCallId());
        receipt.put("manifest", null);
        receipt.put("deliveryStatus", "committed");
        receipt.put("historyRevision", null);
        return BrokerValues.immutableMap(receipt);
    }

    /** The detached capture family: success with a manifest-less capture. */
    static boolean isDetachedCapture(Map<?, ?> result) {
        return result != null && "success".equals(result.get("executionStatus"))
                && result.get("capture") instanceof Map<?, ?> capture
                && "detached".equals(capture.get("captureStatus"))
                && capture.get("manifest") == null;
    }

    static long renewalDelayMillis(Duration duration) {
        return Math.max(1, duration.toMillis() / 3);
    }

    /**
     * A retryable external-workspace provision failure keeps the binding
     * recoverable instead of blocking it: the provider may answer on retry.
     */
    static boolean retryableExternalWorkspaceProvision(
            com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest request, Throwable cause) {
        if (!WorkspaceExecutionProfile.isExternalWorkspaceRequest(request)) {
            return false;
        }
        if (cause instanceof RuntimeBrokerException failure) {
            return failure.isRetryable()
                    && ("runtime_external_provider_failed".equals(failure.getCode())
                            || failure.getStatusCode() == 503 && (externalRetryable(request, failure)
                                    || "runtime_broker_provision_timeout".equals(failure.getCode())
                                    || "managed_runtime_unavailable".equals(failure.getCode())));
        }
        return cause instanceof java.io.IOException || cause instanceof TimeoutException;
    }

    static boolean externalRetryable(
            com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest request,
            RuntimeBrokerException failure) {
        return ExternalRuntimeKinds.isExternal(request.getProvisionerKind())
                && failure.getStatusCode() == 503
                && ("runtime_external_capacity".equals(failure.getCode())
                        || "runtime_external_unavailable".equals(failure.getCode()));
    }

    /**
     * An external-workspace binding that already carries a lease and
     * attestation adopts the worker through reconciliation rather than
     * re-provisioning.
     */
    static boolean shouldReconcileExternalWorkspace(
            com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest request,
            RuntimeBindingRecord record) {
        return WorkspaceExecutionProfile.isExternalWorkspaceRequest(request)
                && record.getResourceHandle() != null && record.getLease() != null
                && record.getAttestationGeneration() > 0;
    }

    /**
     * A drain claim stays valid while its binding is DRAINING, or while a
     * LOST binding still belongs to the claim that captured it.
     */
    static boolean isDrainClaimStateValid(RuntimeBindingRecord binding, boolean stoppedRecovery, boolean lostClaim) {
        return binding.getState() == RuntimeBindingRecord.State.DRAINING
                || (stoppedRecovery || lostClaim) && binding.getState() == RuntimeBindingRecord.State.LOST;
    }
}
