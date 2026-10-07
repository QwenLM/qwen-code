package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Map;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Offline private CREATE only; no worker, Harness, or public CSI selection. */
public final class WorkspaceCsiSessionMain {
    private WorkspaceCsiSessionMain() {
    }

    public record Request(WorkspaceCsiRegistration registration, String actorId,
            String idempotencyKey, String requestedRevision, String title, WorkspaceSelection workspace) {
        public Request {
            if (registration == null || workspace == null || !".".equals(workspace.cwdRelative())
                    || actorId == null || actorId.isEmpty()
                    || idempotencyKey == null || !idempotencyKey.matches("[\\x21-\\x7e]{1,128}")
                    || requestedRevision != null && (requestedRevision.isBlank() || requestedRevision.length() > 128)
                    || title != null && title.length() > 512) {
                throw new IllegalArgumentException("Invalid private CSI Session creation request");
            }
            ManagedWorkspaceRegistry.actorKey(registration.tenantId(), actorId);
        }
    }

    public record Created(String sessionId, String runtimeRequestKey, boolean replayed) {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !"create".equals(args[0])) {
            throw new IllegalArgumentException("Usage: create <reviewed-csi-session-json>");
        }
        ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        Request request = readRequest(Path.of(args[1]), json);
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision(required("K2_AGENT_REVISION"));
        Created created = create(new JdbcTemplate(source), new DataSourceTransactionManager(source),
                json, properties, request);
        System.out.println(json.writeValueAsString(created));
    }

    static Request readRequest(Path path, ObjectMapper json) {
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(32 * 1024 + 1);
            if (bytes.length > 32 * 1024) {
                throw new IllegalArgumentException("CSI Session request exceeds its size limit");
            }
            Request request = json.readValue(bytes, Request.class);
            if (request == null) {
                throw new IllegalArgumentException("CSI Session request is required");
            }
            return request;
        } catch (Exception error) {
            throw new IllegalArgumentException("CSI Session request could not be read");
        }
    }

    static Created create(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ObjectMapper json, ManagedAgentProperties properties, Request request) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("Private CSI CREATE requires a fresh transaction");
        }
        var transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        var reservations = new WorkspaceCsiReservationStore(jdbc, manager, json);
        var sessions = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
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
            reservations.verifyRegistration(request.registration());
            var admission = sessions.insertCsiSessionCommand(request.registration(), request.actorId(),
                    request.idempotencyKey(), digest, request.requestedRevision(), request.title(), request.workspace());
            var original = sessions.requireCsiRequest(request.registration(), admission.sessionId());
            return new Created(admission.sessionId(), original.requestKey(), admission.replayed());
        });
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
