package com.alibaba.qwen.code.managedagent.persistence;
import com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Created;
import com.alibaba.qwen.code.managedagent.contracts.workspace.PrivateCsiSession.Request;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.Map;
public final class WorkspaceCsiSessionCommands {
    private WorkspaceCsiSessionCommands() { }
    public static Created create(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ObjectMapper json, com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings properties, Request request, com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules harnessRules) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Private CSI CREATE requires a fresh transaction");
        }
        var transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        var sessions = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties, harnessRules);
        String digest = new RequestDigests().digest(Map.of("profile", CsiFilesRetirementProfile.PROFILE,
                "request", request));
        return transaction.execute(status -> {
            jdbc.execute((ConnectionCallback<Void>) connection -> {
                if (connection.getAutoCommit() || !DataSourceUtils.isConnectionTransactional(
                        DataSourceUtils.getTargetConnection(connection), jdbc.getDataSource())) {
                    throw new IllegalStateException("Private CSI CREATE requires its original transaction connection");
                }
                JdbcRuntimeBindingRepository.lockPlacementDomain(connection, request.registration().tenantId(), 10);
                return null;
            });
            ToolPublicationRetentionStore.lockTenant(jdbc, request.registration().tenantId());
            reservations.verifyRegistration(request.registration());
            var admission = sessions.insertCsiSessionCommand(request.registration(), request.actorId(),
                    request.idempotencyKey(), digest, request.requestedRevision(), request.title(), request.workspace());
            var original = sessions.requireCsiRequest(request.registration(), admission.sessionId());
            return new Created(admission.sessionId(), original.requestKey(), admission.replayed());
        });
    }
}
