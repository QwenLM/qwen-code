package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.List;

public interface JdbcHarnessResources {
    default List<RuntimeBindingRecord> verifyHarnessResources(Connection connection,
            String tenantId, String harnessSessionId) throws SQLException {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified", "Resource verification is unavailable", false);
    }

    default void verifyHarnessStopped(Connection connection, String tenantId, String harnessSessionId)
            throws SQLException {
        throw new RuntimeBrokerException(409, "workspace_close_identity_unverified", "Stop verification is unavailable", false);
    }
}
