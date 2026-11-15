package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;

import javax.sql.DataSource;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.function.Supplier;

public final class RuntimeBrokerTestAccess {
    private RuntimeBrokerTestAccess() {
    }

    public static boolean matches(RuntimeRecoveryEvidence evidence,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle, RuntimeLease lease) {
        return evidence.matches(seed, handle, lease);
    }

    public static boolean sameIdentity(RuntimeSessionRecord expected, RuntimeSessionRecord actual) {
        return expected.sameIdentity(actual);
    }

    public static boolean sameIdentity(RuntimeBindingRecord expected, RuntimeBindingRecord actual) {
        return expected.sameIdentity(actual);
    }

    public static byte[] encode(RuntimeProvisionSeed seed) {
        return seed.encode();
    }

    public static RuntimeProvisionSeed decodeSeed(byte[] encoded) {
        return RuntimeProvisionSeed.decode(encoded);
    }

    public static <T> T transaction(DataSource source, SqlWork<T> work) {
        return JdbcRepositorySupport.transaction(source, work::run);
    }

    public static void setIdentity(PreparedStatement statement, int index, String value) throws SQLException {
        JdbcRepositorySupport.setIdentity(statement, index, value);
    }

    /**
     * The execution-level authorizing CAS, without the binding-level CSI
     * dispatch admission: mints authorization evidence on a claimed execution
     * whose fixture deliberately omits CSI admission evidence.
     */
    public static ToolExecutionRecord authorizeDispatch(DataSource source, ToolExecutionRecord expected,
            String owner, long generation, long bindingVersion) {
        return JdbcRepositorySupport.transaction(source,
                connection -> JdbcToolExecutionRepository.authorizeDispatch(connection, expected, owner,
                        generation, bindingVersion));
    }

    /**
     * Installs an execution row directly, bypassing the CSI writer
     * qualification the public findOrCreate enforces on profile bindings.
     */
    public static ToolExecutionRecord insertExecution(DataSource source, ToolExecutionRecord record) {
        return JdbcRepositorySupport.transaction(source, connection -> {
            JdbcToolExecutionRepository.insertExecution(connection, record);
            return record;
        });
    }

    /**
     * The owner dispatch CAS without the CSI continuation lock, for fixtures
     * whose execution deliberately omits native CSI continuation evidence.
     */
    public static ToolExecutionRecord compareAndSet(DataSource source, ToolExecutionRecord expected,
            ToolExecutionRecord replacement, String owner, long dispatchGeneration) {
        return JdbcRepositorySupport.transaction(source, connection -> {
            ToolExecutionRecord current = JdbcToolExecutionRepository.selectByExecutionId(
                    connection, expected.getExecutionCallId(), true);
            if (current == null
                    || !current.sameIdentity(expected)
                    || !current.sameAuthorization(expected)
                    || current.getVersion() != expected.getVersion()
                    || current.isTerminal()
                    || current.getState() == ToolExecutionRecord.State.UNKNOWN
                    || !current.sameDispatch(expected)
                    || !current.hasLiveDispatchAt(JdbcRepositorySupport.databaseNowPrecise(connection))
                    || !owner.equals(current.getDispatchOwner())
                    || current.getDispatchGeneration() != dispatchGeneration) {
                return null;
            }
            ToolExecutionRecord updated = replacement.withVersion(expected.getVersion() + 1);
            JdbcToolExecutionRepository.updateExecution(connection, updated);
            return updated;
        });
    }

    public static RuntimeBrokerService service(HarnessSessionResolver sessions,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindings, RuntimeSessionRepository runtimeSessions,
            ToolExecutionRepository executions, String owner, Duration operationLease,
            Duration dispatchLease, Clock clock, Supplier<String> executionIds) {
        return com.alibaba.qwen.code.runtimebroker.service.BrokerServiceTestAccess.create(sessions, provisioner, transport, bindings,
                runtimeSessions, executions, owner, operationLease, dispatchLease, clock, executionIds);
    }

    @FunctionalInterface
    public interface SqlWork<T> {
        public T run(Connection connection) throws SQLException;
    }
}
