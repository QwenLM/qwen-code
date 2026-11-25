package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonClientCapacityException;
import com.alibaba.qwen.code.daemon.DaemonException;
import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HarnessSessionRefusedException;
import com.alibaba.qwen.code.daemon.HostedHarnessCapabilityMismatchException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.HostedHarnessSettleAnsweredException;
import com.alibaba.qwen.code.daemon.HostedHarnessStreamIdleException;
import com.alibaba.qwen.code.daemon.MutationOutcomeUnknownException;
import com.alibaba.qwen.code.managedagent.harness.contracts.*;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

final class HarnessSdkValues {
    private static final ObjectMapper JSON = new ObjectMapper();
    private HarnessSdkValues() { }

    static HarnessRuntimeRecovery recovery(com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery value) {
        return value == null ? null : new HarnessRuntimeRecovery(value.getPhase(), value.getCheckpointId(),
                value.getActivationId(), value.getExecutions().stream().map(execution ->
                    new HarnessRuntimeRecovery.Execution(execution.getFunctionCallId(), execution.getToolName(),
                        execution.getExecutionCallId(), execution.getRuntimeSessionId(), execution.getProgressCursor(),
                        execution.getOutcome(), execution.getStatus())).toList(),
                value.hasUnknownOutcome(), value.isContinuationReady(), value.isCancellationReady());
    }

    static Throwable failure(Throwable error) {
        if (error == null) {
            return null;
        }
        Throwable cause = failure(error.getCause());
        Throwable[] suppressed = Arrays.stream(error.getSuppressed())
                .map(HarnessSdkValues::failure).toArray(Throwable[]::new);
        boolean changed = cause != error.getCause()
                || !Arrays.equals(suppressed, error.getSuppressed());
        Throwable mapped = mapFailure(error, cause);
        if (mapped == error && changed) {
            mapped = error instanceof CompletionException
                    ? new CompletionException(error.getMessage(), cause)
                    : error instanceof ExecutionException
                            ? new ExecutionException(error.getMessage(), cause)
                            : new HarnessFailure(error.getMessage(), cause);
        }
        if (mapped != error) {
            mapped.setStackTrace(error.getStackTrace());
            for (Throwable failure : suppressed) {
                mapped.addSuppressed(failure);
            }
        }
        return mapped;
    }

    private static Throwable mapFailure(Throwable error, Throwable cause) {
        if (error instanceof DaemonHttpException value) {
            return new HarnessHttpFailure(value.getMessage(), cause, value.getStatusCode(), value.getResponseBody(), bodyFields(value));
        }
        if (error instanceof DaemonProtocolException value) {
            return new HarnessProtocolFailure(value.getMessage(), cause);
        }
        if (error instanceof HostedHarnessStreamIdleException value) {
            return new HarnessStreamIdleFailure(value.getMessage(), cause, value.getIdleTimeout());
        }
        if (error instanceof DaemonTransportException value) {
            return new HarnessTransportFailure(value.getMessage(), cause);
        }
        if (error instanceof HostedHarnessGenerationException value) {
            return new HarnessGenerationFailure(value.getMessage(), cause, value.getExpectedBootId(), value.getActualBootId(), value.getCode());
        }
        if (error instanceof HarnessSessionRefusedException value) {
            return new HarnessSessionRefusedFailure(value.getMessage(), cause, value.getStatusCode(), value.getCode());
        }
        if (error instanceof HostedHarnessCapabilityMismatchException value) {
            return new HarnessCapabilityFailure(value.getMessage(), cause, value.getExpectedDigest(), value.getActualDigest(), value.getCode());
        }
        if (error instanceof DaemonClientCapacityException value) {
            return new HarnessCapacityFailure(value.getMessage(), cause);
        }
        if (error instanceof MutationOutcomeUnknownException value) {
            return new HarnessMutationUnknownFailure(value.getMessage(), cause, value.getOperation());
        }
        if (error instanceof HostedHarnessSettleAnsweredException value) {
            return new HarnessSettleAnsweredFailure(value.getMessage(), cause);
        }
        if (error instanceof DaemonException value) {
            return new HarnessFailure(value.getMessage(), cause);
        }
        return error;
    }

    static RuntimeException runtime(RuntimeException error) {
        return (RuntimeException) failure(error);
    }

    private static Map<String, String> bodyFields(DaemonHttpException error) {
        Map<String, String> fields = new LinkedHashMap<>();
        try {
            var body = JSON.readTree(error.getResponseBody());
            if (body != null && body.isObject()) {
                body.fieldNames()
                        .forEachRemaining(
                                name -> {
                                    String value = error.getBodyField(name);
                                    if (value != null) {
                                        fields.put(name, value);
                                    }
                                });
            }
        } catch (IOException | RuntimeException malformed) {
            return Map.of();
        }
        return fields;
    }
}
