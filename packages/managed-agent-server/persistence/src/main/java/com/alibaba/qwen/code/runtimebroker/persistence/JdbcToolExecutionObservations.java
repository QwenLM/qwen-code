package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

import javax.sql.DataSource;

import java.time.Instant;
import java.util.Map;

import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.selectByExecutionId;
import static com.alibaba.qwen.code.runtimebroker.persistence.ToolExecutionRows.updateExecution;

final class JdbcToolExecutionObservations {
    private JdbcToolExecutionObservations() { }

    static ToolExecutionRecord attachMeasurements(
            DataSource dataSource, ToolExecutionRecord expected, Map<String, Object> metadata) {
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    JdbcCsiActivationAdmission.refuseUnqualifiedWriter(
                            connection, expected.getBindingId());
                    ToolExecutionRecord current =
                            selectByExecutionId(connection, expected.getExecutionCallId(), true);
                    if (current == null
                            || !current.sameIdentity(expected)
                            || !current.sameAuthorization(expected)
                            || current.getVersion() != expected.getVersion()
                            || !current.isSettled()) {
                        return null;
                    }
                    ToolExecutionRecord updated =
                            current.withMeasurements(metadata)
                                    .withVersion(current.getVersion() + 1);
                    updateExecution(connection, updated);
                    return updated;
                });
    }

    static ToolExecutionRecord resolve(DataSource dataSource, ToolExecutionRecord expected,
            Map<String, Object> resolutionResult, Instant resolutionTime,
            boolean unknownOnly) {
        if (expected == null) {
            throw new IllegalArgumentException("expected is required");
        }
        return JdbcRepositorySupport.transaction(
                dataSource,
                connection -> {
                    JdbcCsiActivationAdmission.refuseUnqualifiedWriter(
                            connection, expected.getBindingId());
                    ToolExecutionRecord current =
                            selectByExecutionId(connection, expected.getExecutionCallId(), true);
                    if (current == null
                            || !current.sameIdentity(expected)
                            || current.getVersion() != expected.getVersion()
                            || !current.needsReconciliation()
                            || unknownOnly
                                    && current.getState() != ToolExecutionRecord.State.UNKNOWN) {
                        return null;
                    }
                    ToolExecutionRecord resolved =
                            current.resolveUnsettled(resolutionResult, resolutionTime)
                                    .withVersion(current.getVersion() + 1);
                    updateExecution(connection, resolved);
                    return resolved;
                });
    }
}
