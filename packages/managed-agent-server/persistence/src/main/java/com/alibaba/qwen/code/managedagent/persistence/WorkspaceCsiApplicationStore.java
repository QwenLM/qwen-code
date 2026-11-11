package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Authority;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiApplicationRetirement.Stage;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcCsiRetirementEvidence;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson.require;

/** Original Session application retirement; RPCs never hold SQL locks. */
public final class WorkspaceCsiApplicationStore {
    private static final String FORMAT = "qwen-csi-application-retirement/1";
    private static final int RECEIPT_LIMIT = 64 * 1024;
    static final int FROZEN_LIMIT = 32 * 1024 * 1024;
    private static final int BODY_LIMIT = 128 * 1024;
    private static final Set<String> ENVELOPE_FIELDS = Set.of("format", "retirementId", "bindingId", "requestKey",
            "sealedBindingVersion", "bootSha256", "writerTokenSha256", "commitBodyBase64", "preparedCommitSha256",
            "preCutObservationBase64", "preCutObservationSha256", "workerObserveRequest");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JdbcManagedSessionStore nativeStore;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcRuntimeSessionRepository sessions;
    private final RuntimeTransport transport;
    private final WorkspaceCsiApplicationHistory history;

    public WorkspaceCsiApplicationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcManagedSessionStore nativeStore, JdbcRuntimeBindingRepository bindings, JdbcRuntimeSessionRepository sessions,
            RuntimeTransport transport) {
        require(jdbc != null && jdbc.getDataSource() != null && nativeStore != null && bindings != null && sessions != null
                && bindings.usesDataSource(jdbc.getDataSource()) && sessions.usesDataSource(jdbc.getDataSource()) && transport != null);
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
        this.nativeStore = nativeStore;
        this.bindings = bindings;
        this.sessions = sessions;
        this.transport = transport;
        this.history = new WorkspaceCsiApplicationHistory(jdbc, manager, bindings, nativeStore);
    }

    public record Status(String format, String retirementId, String stage, long progressVersion,
            String frozenRequestSha256, String cutSha256, String finalizeReceiptSha256) {
    }

    public Status command(String tenant, String session, String token, String action, byte[] bytes) {
        JsonNode request = WorkspaceCsiApplicationJson.object(bytes, 192 * 1024);
        String argument = switch (action) {
            case "freeze" -> "commitBodyBase64";
            case "cut" -> "frozenRequestSha256";
            case "finalize" -> "cutSha256";
            default -> throw new IllegalArgumentException("Unknown CSI retirement command");
        };
        WorkspaceCsiApplicationJson.closed(request, Set.of("format", "workspaceId", "retirementId", argument));
        require(FORMAT.equals(request.path("format").textValue()) && request.path("workspaceId").isTextual()
                && request.path("retirementId").isTextual());
        String workspace = request.path("workspaceId").textValue();
        String retirement = request.path("retirementId").textValue();
        return switch (action) {
            case "freeze" -> freeze(tenant, session, workspace, retirement, token,
                    WorkspaceCsiApplicationJson.base64(request.path(argument), 128 * 1024));
            case "cut" -> cut(tenant, session, workspace, retirement, token, request.path(argument).textValue());
            case "finalize" -> finalizeApplication(tenant, session, workspace, retirement, token, request.path(argument).textValue());
            default -> throw new IllegalArgumentException("Unknown CSI retirement command");
        };
    }

    public Status status(String tenant, String session, String workspace, String retirement, String token) {
        Status result = tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            verifySaved(target, locked);
            return status(locked.authority());
        });
        if ("DRAINED".equals(result.stage())) {
            history.readApplication(tenant, workspace, session, retirement, token);
        }
        return result;
    }

    public Status freeze(String tenant, String session, String workspace, String retirement, String token, byte[] body) {
        WorkspaceCsiApplicationJson.object(body, BODY_LIMIT);
        var plan = tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            if (locked.authority().stage() != Stage.SETTLING) {
                verifySaved(target, locked);
                require(Arrays.equals(savedBody(locked.authority()), body));
                return new Plan(status(locked.authority()), null, null, null);
            }
            nativeStore.preflightCsiTerminal(target, locked.authority(), token, body, bindings);
            var request = workerRequest(locked, "observe", hash(body), null, null);
            locked.authority().requireCurrentTime(target);
            return new Plan(null, locked.binding(), locked.context(), request);
        });
        if (plan.status() != null) {
            return plan.status();
        }
        byte[] observation = rpc(plan.binding(), plan.context(), operation(plan.request()));
        return tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            if (locked.authority().stage() != Stage.SETTLING) {
                verifySaved(target, locked);
                require(Arrays.equals(savedBody(locked.authority()), body));
                return status(locked.authority());
            }
            var candidate = nativeStore.preflightCsiTerminal(target, locked.authority(), token, body, bindings);
            var expectedRequest = workerRequest(locked, "observe", hash(body), null, null);
            require(same(expectedRequest, plan.request()));
            var evidence = JdbcCsiRetirementEvidence.of(target, locked.authority().original(),
                    candidate.proof(), locked.authority().sealedBindingVersion());
            WorkspaceCsiApplicationWorkerMatch.verify(evidence, observation, expectedRequest);
            var envelope = new LinkedHashMap<String, Object>();
            envelope.put("format", "qwen-csi-application-frozen/1");
            envelope.put("retirementId", retirement);
            envelope.put("bindingId", locked.binding().getBindingId());
            envelope.put("requestKey", locked.authority().original().request().requestKey());
            envelope.put("sealedBindingVersion", locked.authority().sealedBindingVersion());
            envelope.put("bootSha256", expectedRequest.get("bootSha256"));
            envelope.put("writerTokenSha256", candidate.writerTokenSha256());
            envelope.put("commitBodyBase64", encode(body));
            envelope.put("preparedCommitSha256", hash(body));
            envelope.put("preCutObservationBase64", encode(observation));
            envelope.put("preCutObservationSha256", hash(observation));
            envelope.put("workerObserveRequest", expectedRequest);
            byte[] frozen = WorkspaceCsiApplicationJson.encode(envelope);
            require(frozen.length <= FROZEN_LIMIT);
            locked.authority().requireCurrentTime(target);
            require(jdbc.update("UPDATE ma_operation SET progress_stage = 'FROZEN', progress_version = 2,"
                            + " frozen_request_bytes = ?, frozen_request_sha256 = ? WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT'"
                            + " AND progress_stage = 'SETTLING' AND progress_version = 1 AND frozen_request_bytes IS NULL",
                    frozen, hash(frozen), WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement)) == 1);
            locked.authority().requireCurrentTime(target);
            return new Status(FORMAT, retirement, "FROZEN", 2, hash(frozen), null, null);
        });
    }

    public Status cut(String tenant, String session, String workspace, String retirement, String token, String frozenDigest) {
        digest(frozenDigest);
        return tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            var authority = locked.authority();
            require(authority.stage() != Stage.SETTLING && hash(authority.frozenBytes()).equals(frozenDigest));
            verifySaved(target, locked);
            if (authority.stage() != Stage.FROZEN) {
                return status(authority);
            }
            byte[] body = savedBody(authority);
            String writtenAt = nativeStore.commitCsiTerminal(target, authority, token, body, bindings);
            byte[] cut = WorkspaceCsiApplicationJson.encode(Map.of("format", "qwen-csi-application-cut/1", "retirementId", retirement,
                    "frozenRequestSha256", frozenDigest, "preparedCommitSha256", hash(body), "writtenAt", writtenAt));
            authority.requireCurrentTime(target);
            require(jdbc.update("UPDATE ma_operation SET progress_stage = 'CUT', progress_version = 3,"
                            + " cut_bytes = ?, cut_sha256 = ? WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND progress_stage = 'FROZEN'"
                            + " AND progress_version = 2 AND frozen_request_sha256 = ? AND cut_bytes IS NULL",
                    cut, hash(cut), WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement), frozenDigest) == 1);
            authority.requireCurrentTime(target);
            JdbcCsiApplicationRetirement.lock(target, tenant, session, authority.original().bindingId(), retirement);
            return new Status(FORMAT, retirement, "CUT", 3, frozenDigest, hash(cut), null);
        });
    }

    public Status finalizeApplication(String tenant, String session, String workspace, String retirement, String token, String cutDigest) {
        digest(cutDigest);
        var plan = tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            var authority = locked.authority();
            require((authority.stage() == Stage.CUT || authority.stage() == Stage.DRAINED) && hash(authority.cutBytes()).equals(cutDigest));
            verifySaved(target, locked);
            if (authority.stage() == Stage.DRAINED) {
                return new Plan(status(authority), null, null, null);
            }
            return new Plan(null, locked.binding(), locked.context(), workerRequest(locked, "finalize",
                    hash(savedBody(authority)), hash(authority.frozenBytes()), cutDigest));
        });
        if (plan.status() != null) {
            return plan.status();
        }
        byte[] receipt = rpc(plan.binding(), plan.context(), operation(plan.request()));
        require(receipt.length <= RECEIPT_LIMIT);
        return tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            var authority = locked.authority();
            require((authority.stage() == Stage.CUT || authority.stage() == Stage.DRAINED) && hash(authority.cutBytes()).equals(cutDigest));
            verifySaved(target, locked);
            if (authority.stage() == Stage.DRAINED) {
                require(Arrays.equals(authority.receiptBytes(), receipt));
                return status(authority);
            }
            var request = workerRequest(locked, "finalize", hash(savedBody(authority)), hash(authority.frozenBytes()), cutDigest);
            require(same(request, plan.request()));
            var response = CsiFileFinalizeProtocol.response(receipt, request);
            var envelope = envelope(locked);
            require(envelope.path("preCutObservationSha256").textValue().equals(response.get("preCutObservationSha256")));
            require(jdbc.update("UPDATE ma_operation SET finalize_receipt_bytes = ?, finalize_receipt_sha256 = ?"
                            + " WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND progress_stage = 'CUT' AND progress_version = 3"
                            + " AND cut_sha256 = ? AND finalize_receipt_bytes IS NULL", receipt, hash(receipt), WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement), cutDigest) == 1);
            sessions.completeCsiApplication(target, authority, bindings, receipt);
            require(jdbc.update("UPDATE ma_operation SET progress_stage = 'DRAINED', progress_version = 4"
                            + " WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND progress_stage = 'CUT' AND progress_version = 3"
                            + " AND cut_sha256 = ? AND finalize_receipt_sha256 = ?", WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement), cutDigest, hash(receipt)) == 1);
            JdbcCsiApplicationRetirement.lock(target, tenant, session, authority.original().bindingId(), retirement);
            return new Status(FORMAT, retirement, "DRAINED", 4, hash(authority.frozenBytes()), cutDigest, hash(receipt));
        });
    }

    public Map<String, Object> workerAuthority(String tenant, String session, String token, byte[] body) {
        JsonNode request = WorkspaceCsiApplicationJson.object(body, CsiFileFinalizeProtocol.REQUEST_LIMIT);
        return tx(target -> {
            String workspace = request.path("context").path("workspaceId").textValue();
            String retirement = request.path("retirementId").textValue();
            var locked = lock(target, tenant, session, workspace, retirement);
            var authority = locked.authority();
            require(authority.stage() == Stage.CUT || authority.stage() == Stage.DRAINED);
            byte[] credential = token == null ? new byte[0] : token.getBytes(StandardCharsets.UTF_8);
            boolean seedMatches = MessageDigest.isEqual(credential, locked.binding().getProvisionSeed().getToken().getBytes(StandardCharsets.UTF_8));
            boolean leaseMatches = MessageDigest.isEqual(credential, locked.binding().getLease().getToken().getBytes(StandardCharsets.UTF_8));
            if (!seedMatches || !leaseMatches) {
                throw new RuntimeBrokerException(401, "csi_application_authority_unauthorized", "Original Runtime authentication failed.", false);
            }
            verifySaved(target, locked);
            var expected = workerRequest(locked, "finalize", hash(savedBody(authority)), hash(authority.frozenBytes()), hash(authority.cutBytes()));
            require(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(expected), CsiFileFinalizeProtocol.REQUEST_LIMIT).equals(request));
            return Map.of("format", "qwen-csi-application-cut-authority/1", "retirementId", retirement,
                    "preparedCommitSha256", hash(savedBody(authority)), "frozenRequestSha256", hash(authority.frozenBytes()),
                    "cutSha256", hash(authority.cutBytes()), "preCutObservationSha256", envelope(locked).path("preCutObservationSha256").textValue(),
                    "workerRequestSha256", WorkspaceCsiRuntimeIdentity.digest(expected));
        });
    }

    private Locked lock(Connection target, String tenant, String session, String workspace, String retirement) throws SQLException {
        require(tenant != null && session != null && workspace != null && retirement != null
                && UUID.fromString(retirement).toString().equals(retirement));
        var candidates = jdbc.queryForList("SELECT target_id FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND tenant_id = ? AND operation_id = ?",
                String.class, WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement), tenant, retirement);
        require(candidates.size() == 1);
        var authority = JdbcCsiApplicationRetirement.lock(target, tenant, session, candidates.getFirst(), retirement);
        require(workspace.equals(authority.original().request().getScope().getWorkspaceId()));
        var binding = bindings.findByIdForUpdate(target, authority.original().bindingId());
        require(binding != null && binding.getGeneration() == 1 && binding.getVersion() == authority.original().version()
                && binding.getRequest().equals(authority.original().request()));
        WorkspaceCsiRuntimeIdentity.boot(binding);
        return new Locked(authority, binding, context(target, tenant, workspace, session));
    }

    private static ContextBinding context(Connection target, String tenant, String workspace, String session) throws SQLException {
        try (PreparedStatement statement = target.prepareStatement("SELECT workspace_generation, workspace_storage_id,"
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

    private void verifySaved(Connection target, Locked locked) throws SQLException {
        var authority = locked.authority();
        if (authority.stage() == Stage.SETTLING) {
            return;
        }
        var evidence = JdbcCsiRetirementEvidence.saved(target, authority, bindings);
        var value = envelope(locked);
        requireSavedWriter(target, authority, value);
        WorkspaceCsiApplicationWorkerMatch.verify(evidence, savedObservation(value), savedRequest(locked, value));
        if (authority.stage() == Stage.DRAINED) {
            var response = CsiFileFinalizeProtocol.response(authority.receiptBytes(), workerRequest(locked, "finalize",
                    hash(savedBody(authority)), hash(authority.frozenBytes()), hash(authority.cutBytes())));
            require(value.path("preCutObservationSha256").textValue().equals(response.get("preCutObservationSha256")));
        }
    }

    private JsonNode envelope(Locked locked) {
        var authority = locked.authority();
        return savedEnvelope(locked.binding(), locked.context(), authority.retirementId(),
                authority.sealedBindingVersion(), authority.frozenBytes());
    }

    /** The frozen envelope's own digests and Worker request; the journal proof is checked separately. */
    static JsonNode savedEnvelope(RuntimeBindingRecord binding, ContextBinding context, String retirement,
            long ceiling, byte[] frozenBytes) {
        JsonNode value = WorkspaceCsiApplicationJson.object(frozenBytes, FROZEN_LIMIT);
        WorkspaceCsiApplicationJson.closed(value, ENVELOPE_FIELDS);
        byte[] body = WorkspaceCsiApplicationJson.base64(value.path("commitBodyBase64"), BODY_LIMIT);
        var terminal = JdbcManagedSessionStore.validateCsiTerminalBytes(body);
        require("qwen-csi-application-frozen/1".equals(value.path("format").textValue())
                && retirement.equals(value.path("retirementId").textValue())
                && binding.getBindingId().equals(value.path("bindingId").textValue())
                && binding.getRequest().requestKey().equals(value.path("requestKey").textValue())
                && ceiling > 0 && ceiling <= binding.getVersion()
                && value.path("sealedBindingVersion").isIntegralNumber() && value.path("sealedBindingVersion").longValue() == ceiling
                && WorkspaceCsiRuntimeIdentity.digest(WorkspaceCsiRuntimeIdentity.boot(binding)).equals(value.path("bootSha256").textValue())
                && hash(body).equals(value.path("preparedCommitSha256").textValue())
                && binding.getRequest().getScope().getWorkspaceId().equals(terminal.workspaceId()));
        var observation = savedObservation(value);
        var expected = workerRequest(binding, context, retirement, "observe", hash(body), null, null);
        require(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(expected), CsiFileFinalizeProtocol.REQUEST_LIMIT)
                .equals(value.path("workerObserveRequest")));
        CsiFileFinalizeProtocol.response(observation, expected);
        return value;
    }

    static byte[] savedObservation(JsonNode value) {
        var observation = WorkspaceCsiApplicationJson.base64(value.path("preCutObservationBase64"), CsiFileFinalizeProtocol.RESPONSE_LIMIT);
        require(hash(observation).equals(value.path("preCutObservationSha256").textValue()));
        return observation;
    }

    private static Map<String, Object> savedRequest(Locked locked, JsonNode value) {
        return workerRequest(locked.binding(), locked.context(), locked.authority().retirementId(), "observe",
                hash(WorkspaceCsiApplicationJson.base64(value.path("commitBodyBase64"), BODY_LIMIT)), null, null);
    }

    /**
     * The frozen writer credential must still be the Session head's own. The head's writer identity
     * and journal position are already pinned to the same terminal proof by the native head read
     * (pre-cut) or the terminal history read (post-cut).
     */
    static void requireSavedWriter(Connection target, Authority authority, JsonNode value) throws SQLException {
        String tenant = authority.original().request().getScope().getTenantId();
        String session = authority.original().request().getIsolationKey();
        try (PreparedStatement statement = target.prepareStatement("SELECT lease_token_hash FROM ma_session_head"
                + " WHERE head_kind = 'MANAGED_SESSION' AND tenant_key = ? AND harness_key = ? AND tenant_id = ? AND session_id = ?")) {
            statement.setString(1, JdbcRuntimeBindingRepository.harnessDrainKey(tenant));
            statement.setString(2, JdbcRuntimeBindingRepository.harnessDrainKey(session));
            statement.setBytes(3, ManagedSchemaKeys.identity(tenant));
            statement.setBytes(4, ManagedSchemaKeys.identity(session));
            try (var row = statement.executeQuery()) {
                require(row.next() && value.path("writerTokenSha256").textValue().equals(row.getString("lease_token_hash"))
                        && !row.next());
            }
        }
    }

    private static Map<String, Object> workerRequest(Locked locked, String action, String prepared, String frozen, String cut) {
        return workerRequest(locked.binding(), locked.context(), locked.authority().retirementId(), action, prepared, frozen, cut);
    }

    static Map<String, Object> workerRequest(RuntimeBindingRecord binding, ContextBinding context, String retirement,
            String action, String prepared, String frozen, String cut) {
        var operation = new LinkedHashMap<String, Object>();
        operation.put("operation", action);
        operation.put("retirementId", retirement);
        operation.put("preparedCommitSha256", prepared);
        operation.put("frozenRequestSha256", frozen);
        operation.put("cutSha256", cut);
        return CsiFileFinalizeProtocol.request(binding, context, operation);
    }

    private static Map<String, Object> operation(Map<String, Object> request) {
        var result = new LinkedHashMap<String, Object>();
        for (String field : Set.of("operation", "retirementId", "preparedCommitSha256", "frozenRequestSha256", "cutSha256")) {
            result.put(field, request.get(field));
        }
        return result;
    }

    private byte[] rpc(RuntimeBindingRecord binding, ContextBinding context, Map<String, Object> operation) {
        try {
            return transport.csiFileFinalize(binding, context, operation).toCompletableFuture().get(30, TimeUnit.SECONDS);
        } catch (Exception failure) {
            if (failure instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw unavailable();
        }
    }

    private <T> T tx(Sql<T> work) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        long started = System.nanoTime();
        return transaction.execute(status -> jdbc.execute((ConnectionCallback<T>) connection -> {
            Connection target = DataSourceUtils.getTargetConnection(connection);
            require(!target.getAutoCommit() && DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource()));
            T result = work.run(bounded(target, started));
            require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
            return result;
        }));
    }

    static Connection bounded(Connection target, long started) {
        return (Connection) Proxy.newProxyInstance(WorkspaceCsiApplicationStore.class.getClassLoader(),
                new Class<?>[] {org.springframework.jdbc.datasource.ConnectionProxy.class}, (proxy, method, arguments) -> {
                    if (method.getName().equals("getTargetConnection")) {
                        return target;
                    }
                    try {
                        if (method.getName().equals("prepareStatement")) {
                            remaining(started);
                            var statement = (PreparedStatement) method.invoke(target, arguments);
                            statement.setQueryTimeout(remaining(started));
                            return Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {PreparedStatement.class},
                                    (prepared, operation, parameters) -> {
                                        try {
                                            if (operation.getName().equals("setQueryTimeout")) {
                                                statement.setQueryTimeout(Math.min((Integer) parameters[0], remaining(started)));
                                                return null;
                                            }
                                            if (operation.getName().startsWith("execute")) {
                                                statement.setQueryTimeout(remaining(started));
                                            }
                                            return operation.invoke(statement, parameters);
                                        } catch (InvocationTargetException failure) {
                                            throw failure.getCause();
                                        }
                                    });
                        }
                        return method.invoke(target, arguments);
                    } catch (InvocationTargetException failure) {
                        throw failure.getCause();
                    }
                });
    }

    private static int remaining(long started) throws SQLException {
        long seconds = TimeUnit.NANOSECONDS.toSeconds(TimeUnit.SECONDS.toNanos(10) - (System.nanoTime() - started));
        if (seconds < 1) {
            throw new java.sql.SQLTimeoutException("Original CSI transaction expired");
        }
        return Math.toIntExact(seconds);
    }

    private static Status status(Authority authority) {
        return new Status(FORMAT, authority.retirementId(), authority.stage().name(), authority.stage().ordinal() + 1L,
                authority.frozenBytes() == null ? null : hash(authority.frozenBytes()),
                authority.cutBytes() == null ? null : hash(authority.cutBytes()),
                authority.receiptBytes() == null ? null : hash(authority.receiptBytes()));
    }

    private static byte[] savedBody(Authority authority) {
        return WorkspaceCsiApplicationJson.base64(WorkspaceCsiApplicationJson.object(authority.frozenBytes(),
                FROZEN_LIMIT).path("commitBodyBase64"), BODY_LIMIT);
    }
    private static boolean same(Object left, Object right) {
        return WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(left), FROZEN_LIMIT)
                .equals(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(right), FROZEN_LIMIT));
    }
    private static String encode(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }
    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
    private static void digest(String value) { require(value != null && value.matches("[0-9a-f]{64}")); }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_application_retirement_unavailable", "Original CSI application retirement is unavailable.", false);
    }
    private interface Sql<T> { T run(Connection target) throws SQLException; }
    private record Locked(Authority authority, RuntimeBindingRecord binding, ContextBinding context) { }
    private record Plan(Status status, RuntimeBindingRecord binding, ContextBinding context, Map<String, Object> request) { }
}
