package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiRetirementEvidence;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson.require;

/**
 * Read-only application semantics while the original DRAINING holder remains reserved.
 *
 * <p>The historical read repeats the live retirement's own proofs against a REPEATABLE READ
 * snapshot: the retirement seal, the terminal journal history, the Session-scoped executions and
 * resources, and the saved Worker observation and receipt. It reads only this Session's rows.
 */
final class WorkspaceCsiApplicationHistory {
    private final JdbcTemplate jdbc;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcManagedSessionStore nativeStore;
    private final TransactionTemplate transaction;

    WorkspaceCsiApplicationHistory(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, JdbcManagedSessionStore nativeStore) {
        require(jdbc != null && jdbc.getDataSource() != null && manager != null && bindings != null && nativeStore != null
                && bindings.usesDataSource(jdbc.getDataSource()) && nativeStore.usesDataSource(jdbc.getDataSource()));
        this.jdbc = jdbc;
        this.bindings = bindings;
        this.nativeStore = nativeStore;
        transaction = new TransactionTemplate(manager);
        transaction.setReadOnly(true);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transaction.setTimeout(10);
    }

    /** Reads the closed application while its original binding and holder remain DRAINING. */
    void readApplication(String tenant, String workspace, String session, String retirement, String token) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        long started = System.nanoTime();
        transaction.execute(status -> jdbc.execute((ConnectionCallback<Void>) current -> {
            var target = DataSourceUtils.getTargetConnection(current);
            require(!target.getAutoCommit() && target.isReadOnly()
                    && target.getTransactionIsolation() == Connection.TRANSACTION_REPEATABLE_READ
                    && DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource()));
            var connection = WorkspaceCsiApplicationStore.bounded(target, started);
            var saved = savedApplication(connection, tenant, workspace, session, retirement);
            var envelope = WorkspaceCsiApplicationJson.object(saved.frozen(), WorkspaceCsiApplicationStore.FROZEN_LIMIT);
            nativeStore.requireCsiHistoricalCredential(tenant, workspace, session, token,
                    envelope.path("writerTokenSha256").textValue());
            var evidence = JdbcCsiRetirementEvidence.historical(connection, saved.binding(), saved.frozen(), started);
            var context = context(connection, tenant, workspace, session);
            var value = WorkspaceCsiApplicationStore.savedEnvelope(saved.binding(), context, retirement,
                    evidence.sealedBindingVersion(), saved.frozen());
            byte[] body = WorkspaceCsiApplicationJson.base64(value.path("commitBodyBase64"),
                    com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.TERMINAL_BODY_LIMIT);
            WorkspaceCsiApplicationWorkerMatch.verify(evidence, WorkspaceCsiApplicationStore.savedObservation(value),
                    WorkspaceCsiApplicationStore.workerRequest(saved.binding(), context, retirement, "observe", hash(body), null, null));
            var finalize = WorkspaceCsiApplicationStore.workerRequest(saved.binding(), context, retirement, "finalize",
                    hash(body), hash(saved.frozen()), hash(saved.cut()));
            var response = CsiFileFinalizeProtocol.response(saved.receipt(), finalize);
            require(value.path("preCutObservationSha256").textValue().equals(response.get("preCutObservationSha256")));
            require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
            return null;
        }));
    }

    private Saved savedApplication(Connection connection, String tenant, String workspace, String session,
            String retirement) throws SQLException {
        byte[] frozen;
        byte[] cut;
        byte[] receipt;
        String bindingId;
        try (PreparedStatement statement = connection.prepareStatement("SELECT target_id, target_revision, phase,"
                + " progress_format, progress_stage, progress_version, frozen_request_bytes, frozen_request_sha256,"
                + " cut_bytes, cut_sha256, finalize_receipt_bytes, finalize_receipt_sha256 FROM ma_operation"
                + " WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND tenant_id = ? AND operation_id = ?")) {
            statement.setString(1, WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement));
            statement.setString(2, tenant);
            statement.setString(3, retirement);
            try (var row = statement.executeQuery()) {
                require(row.next() && "DRAINING".equals(row.getString("phase"))
                        && "qwen-csi-application-retirement/1".equals(row.getString("progress_format"))
                        && "DRAINED".equals(row.getString("progress_stage")) && row.getLong("progress_version") == 4
                        && row.getLong("target_revision") == 1);
                bindingId = ManagedSchemaRows.identity(row, "target_id");
                frozen = payload(row, "frozen_request", WorkspaceCsiApplicationStore.FROZEN_LIMIT);
                cut = payload(row, "cut", 4096);
                receipt = payload(row, "finalize_receipt", 64 * 1024);
                require(!row.next());
            }
        }
        var binding = bindings.findByIdInReadOnlySnapshot(connection, bindingId);
        require(binding != null && binding.getState() == RuntimeBindingRecord.State.DRAINING
                && binding.isDrainRequested() && binding.getGeneration() == 1
                && binding.getBindingId().equals(bindingId)
                && binding.getRequest().getScope().getTenantId().equals(tenant)
                && binding.getRequest().getScope().getWorkspaceId().equals(workspace)
                && binding.getRequest().getIsolationKey().equals(session));
        return new Saved(binding, frozen, cut, receipt);
    }

    private static ContextBinding context(Connection connection, String tenant, String workspace, String session)
            throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT workspace_generation, workspace_storage_id,"
                + " cwd_relative, context_config_ref, context_revision FROM ma_session"
                + " WHERE tenant_id = ? AND session_id = ? AND workspace_id = ?")) {
            statement.setBytes(1, ManagedSchemaKeys.identity(tenant));
            statement.setBytes(2, ManagedSchemaKeys.identity(session));
            statement.setBytes(3, ManagedSchemaKeys.identity(workspace));
            try (var row = statement.executeQuery()) {
                require(row.next());
                var result = new ContextBinding(tenant, workspace, row.getLong("workspace_generation"),
                        ManagedSchemaRows.identity(row, "workspace_storage_id"), ManagedSchemaRows.identity(row, "cwd_relative"),
                        ManagedSchemaRows.identity(row, "context_config_ref"), row.getLong("context_revision"));
                require(!row.next());
                return result;
            }
        }
    }

    private static byte[] payload(java.sql.ResultSet row, String field, int limit) throws SQLException {
        byte[] bytes = row.getBytes(field + "_bytes");
        require(bytes != null && bytes.length > 0 && bytes.length <= limit
                && hash(bytes).equals(row.getString(field + "_sha256")));
        return bytes;
    }

    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }

    private record Saved(RuntimeBindingRecord binding, byte[] frozen, byte[] cut, byte[] receipt) { }
}
