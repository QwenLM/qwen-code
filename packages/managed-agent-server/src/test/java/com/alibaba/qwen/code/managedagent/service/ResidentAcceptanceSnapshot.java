package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.ResidentWorkspace;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Clob;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Read-only, bounded ownership evidence for the explicitly configured experiment Workspace. */
public final class ResidentAcceptanceSnapshot {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ResidentWorkspace mapping;
    private final ObjectMapper json;

    public ResidentAcceptanceSnapshot(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ResidentWorkspace mapping, ObjectMapper json) {
        if (jdbc.getDataSource() == null || !(manager instanceof DataSourceTransactionManager original)
                || original.getDataSource() != jdbc.getDataSource()) {
            throw new IllegalArgumentException("Original same DataSource transaction manager required");
        }
        this.jdbc = jdbc;
        this.mapping = mapping;
        this.json = json;
        transaction = new TransactionTemplate(manager);
        transaction.setReadOnly(true);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transaction.setTimeout(10);
    }

    public JsonNode capture() {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Independent evidence transaction required");
        }
        return transaction.execute(status -> {
            var tables = new LinkedHashMap<String, Object>();
            var registration = mapping.registration();
            byte[] tenant = bytes(registration.tenantId());
            byte[] workspace = bytes(mapping.workspaceId());
            tables.put("ma_session", rows("SELECT session_id, tenant_id, workspace_id, workspace_generation,"
                    + " workspace_storage_id, cwd_relative, session_kind, status, runtime_request_key"
                    + " FROM ma_session WHERE tenant_id = ? AND workspace_id = ? ORDER BY session_id", tenant, workspace));
            tables.put("ma_runtime_binding", rows("SELECT * FROM ma_runtime_binding"
                    + " WHERE tenant_id = ? AND workspace_id = ? ORDER BY binding_id", tenant, workspace));
            tables.put("ma_runtime_slot", rows("SELECT * FROM ma_runtime_slot"
                    + " WHERE tenant_id = ? AND workspace_id = ? ORDER BY request_key", tenant, workspace));
            tables.put("ma_runtime_session", rows("SELECT * FROM ma_runtime_session"
                    + " WHERE tenant_id = ? AND workspace_id = ? ORDER BY runtime_session_id", tenant, workspace));
            tables.put("ma_storage", rows("SELECT * FROM ma_storage WHERE alias_key = ?", registration.aliasKey()));
            tables.put("ma_storage_owner", rows("SELECT * FROM ma_storage_owner"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI'", registration.physicalKey()));
            tables.put("ma_tool_execution", rows("SELECT e.execution_call_id, e.binding_id, e.runtime_generation,"
                    + " e.harness_session_id, e.runtime_session_id, e.execution_state, e.execution_status,"
                    + " e.last_sequence, e.record_version FROM ma_tool_execution e JOIN ma_runtime_binding b"
                    + " ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND b.workspace_id = ?"
                    + " ORDER BY e.execution_call_id", tenant, workspace));
            tables.put("ma_operation", rows("SELECT operation_id, session_id, operation_kind, state, phase,"
                    + " lifecycle_protocol_version, lifecycle_effects_receipt_json, failure_code"
                    + " FROM ma_operation WHERE tenant_id = ? AND session_id IN"
                    + " (SELECT session_id FROM ma_session WHERE tenant_id = ? AND workspace_id = ?)"
                    + " ORDER BY operation_id", tenant, tenant, workspace));
            return json.valueToTree(Map.of("format", "resident-ownership-snapshot/1",
                    "tenant", registration.tenantId(), "workspace", mapping.workspaceId(),
                    "workspaceGeneration", mapping.workspaceGeneration(), "tables", tables));
        });
    }

    private List<Map<String, Object>> rows(String sql, Object... arguments) {
        return jdbc.query(connection -> {
            var statement = connection.prepareStatement(sql);
            statement.setMaxRows(65);
            statement.setQueryTimeout(5);
            for (int index = 0; index < arguments.length; index++) {
                statement.setObject(index + 1, arguments[index]);
            }
            return statement;
        }, result -> {
            var rows = new ArrayList<Map<String, Object>>();
            var metadata = result.getMetaData();
            while (result.next()) {
                if (rows.size() == 64) {
                    throw new IllegalStateException("Experiment ownership row limit exceeded");
                }
                var row = new LinkedHashMap<String, Object>();
                for (int index = 1; index <= metadata.getColumnCount(); index++) {
                    String column = metadata.getColumnLabel(index).toLowerCase(java.util.Locale.ROOT);
                    row.put(column, cell(column, result.getObject(index)));
                }
                rows.add(row);
            }
            return rows;
        });
    }

    private static Object cell(String column, Object value) throws SQLException {
        if (value == null) {
            return null;
        }
        if (value instanceof Clob clob) {
            if (clob.length() > 65536) {
                throw new IllegalStateException("Experiment cell limit exceeded");
            }
            value = clob.getSubString(1, Math.toIntExact(clob.length()));
        }
        if (value instanceof byte[] binary) {
            return Map.of("type", "bytes", "value", Base64.getEncoder().encodeToString(binary));
        }
        if (value instanceof String text) {
            byte[] encoded = bytes(text);
            if (encoded.length > 65536) {
                throw new IllegalStateException("Experiment cell limit exceeded");
            }
            return column.endsWith("_json") || column.endsWith("_ciphertext")
                    ? Map.of("type", "sha256", "bytes", encoded.length, "value", DigestUtils.sha256Hex(encoded)) : text;
        }
        if (value instanceof Number || value instanceof Boolean) {
            return value;
        }
        if (value instanceof java.sql.Timestamp timestamp) {
            return Map.of("type", "timestamp", "value", timestamp.toLocalDateTime().toString());
        }
        throw new IllegalStateException("Unexpected experiment JDBC value " + value.getClass().getName());
    }

    private static byte[] bytes(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
