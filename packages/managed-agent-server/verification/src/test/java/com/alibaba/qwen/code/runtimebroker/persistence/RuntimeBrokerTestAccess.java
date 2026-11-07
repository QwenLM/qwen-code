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
