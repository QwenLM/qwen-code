package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Authority;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

/** Original Session application retirement; RPCs never hold SQL locks. */
public final class WorkspaceCsiApplicationStore {
    private static final ObjectMapper IDENTITY_JSON = new ObjectMapper()
            .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final String FORMAT = "qwen-csi-application-retirement/1";
    private static final int RECEIPT_LIMIT = 64 * 1024;
    private static final Set<String> ENVELOPE_FIELDS = Set.of("format", "retirementId", "bindingId", "requestKey",
            "sealedBindingVersion", "bootSha256", "writerTokenSha256", "commitBodyBase64", "preparedCommitSha256",
            "baselineBase64", "baselineSha256", "preCutObservationBase64", "preCutObservationSha256", "workerObserveRequest");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final ManagedSessionStore nativeStore;
    private final JdbcRuntimeBindingRepository bindings;
    private final JdbcRuntimeSessionRepository sessions;
    private final RuntimeTransport transport;
    private final WorkspaceCsiApplicationHistory history;

    public WorkspaceCsiApplicationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedSessionStore nativeStore, JdbcRuntimeBindingRepository bindings, JdbcRuntimeSessionRepository sessions) {
        this(jdbc, manager, nativeStore, bindings, sessions, new HttpRuntimeTransport());
    }

    WorkspaceCsiApplicationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            ManagedSessionStore nativeStore, JdbcRuntimeBindingRepository bindings, JdbcRuntimeSessionRepository sessions,
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
        this.history = new WorkspaceCsiApplicationHistory(jdbc, manager, bindings, nativeStore, IDENTITY_JSON);
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
            verifySaved(locked);
            return status(locked.authority());
        });
        if ("DRAINED".equals(result.stage())) {
            history.readApplication(tenant, workspace, session, retirement, token);
        }
        return result;
    }

    public Status freeze(String tenant, String session, String workspace, String retirement, String token, byte[] body) {
        WorkspaceCsiApplicationJson.object(body, 128 * 1024);
        var plan = tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            if (locked.authority().stage() != Stage.SETTLING) {
                verifySaved(locked);
                require(Arrays.equals(savedBody(locked.authority()), body));
                return new Plan(status(locked.authority()), null, null, null, null);
            }
            nativeStore.preflightCsiTerminal(target, locked.authority(), token, body, bindings);
            require(locked.inventory().blockers().isEmpty());
            var request = workerRequest(locked, "observe", hash(body), null, null);
            locked.authority().requireCurrentTime(target);
            return new Plan(null, locked.binding(), locked.context(), locked.inventory(), request);
        });
        if (plan.status() != null) {
            return plan.status();
        }
        byte[] observation = rpc(plan.binding(), plan.context(), operation(plan.request()));
        return tx(target -> {
            var locked = lock(target, tenant, session, workspace, retirement);
            nativeStore.requireCsiApplicationCredential(target, locked.authority(), token);
            if (locked.authority().stage() != Stage.SETTLING) {
                verifySaved(locked);
                require(Arrays.equals(savedBody(locked.authority()), body));
                return status(locked.authority());
            }
            WorkspaceCsiApplicationImage.verify(locked.inventory(), plan.baseline());
            var candidate = nativeStore.preflightCsiTerminal(target, locked.authority(), token, body, bindings);
            var expectedRequest = workerRequest(locked, "observe", hash(body), null, null);
            require(same(expectedRequest, plan.request()));
            WorkspaceCsiApplicationWorkerMatch.verify(locked.inventory(), candidate.proof(), observation, expectedRequest);
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
            envelope.put("baselineBase64", encode(locked.inventory().bytes()));
            envelope.put("baselineSha256", hash(locked.inventory().bytes()));
            envelope.put("preCutObservationBase64", encode(observation));
            envelope.put("preCutObservationSha256", hash(observation));
            envelope.put("workerObserveRequest", expectedRequest);
            byte[] frozen = WorkspaceCsiApplicationJson.encode(envelope);
            require(frozen.length <= WorkspaceCsiApplicationInventory.MAX_BYTES);
            var expected = WorkspaceCsiApplicationImage.expected(locked.inventory(), Stage.FROZEN, frozen, null, null);
            // Reserve space for the terminal rows, cut and bounded cleanup receipt before irreversible freezing.
            require(expected.rowCount() <= WorkspaceCsiApplicationInventory.MAX_ROWS - 3
                    && expected.bytes().length + body.length * 2L + 256 * 1024 < WorkspaceCsiApplicationInventory.MAX_BYTES);
            locked.authority().requireCurrentTime(target);
            require(jdbc.update("UPDATE ma_operation SET progress_stage = 'FROZEN', progress_version = 2,"
                            + " frozen_request_bytes = ?, frozen_request_sha256 = ? WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT'"
                            + " AND progress_stage = 'SETTLING' AND progress_version = 1 AND frozen_request_bytes IS NULL",
                    frozen, hash(frozen), WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement)) == 1);
            locked.authority().requireCurrentTime(target);
            WorkspaceCsiApplicationImage.verify(inspect(target, locked), expected);
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
            verifySaved(locked);
            if (authority.stage() != Stage.FROZEN) {
                return status(authority);
            }
            byte[] body = savedBody(authority);
            String writtenAt = nativeStore.commitCsiTerminal(target, authority, token, body, bindings);
            byte[] cut = WorkspaceCsiApplicationJson.encode(Map.of("format", "qwen-csi-application-cut/1", "retirementId", retirement,
                    "frozenRequestSha256", frozenDigest, "baselineSha256", hash(WorkspaceCsiApplicationImage.baseline(authority.frozenBytes()).bytes()),
                    "preparedCommitSha256", hash(body), "writtenAt", writtenAt));
            authority.requireCurrentTime(target);
            require(jdbc.update("UPDATE ma_operation SET progress_stage = 'CUT', progress_version = 3,"
                            + " cut_bytes = ?, cut_sha256 = ? WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT' AND progress_stage = 'FROZEN'"
                            + " AND progress_version = 2 AND frozen_request_sha256 = ? AND cut_bytes IS NULL",
                    cut, hash(cut), WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement), frozenDigest) == 1);
            authority.requireCurrentTime(target);
            WorkspaceCsiApplicationImage.verify(inspect(target, locked), WorkspaceCsiApplicationImage.expected(
                    WorkspaceCsiApplicationImage.baseline(authority.frozenBytes()), Stage.CUT, authority.frozenBytes(), cut, null));
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
            verifySaved(locked);
            if (authority.stage() == Stage.DRAINED) {
                return new Plan(status(authority), null, null, null, null);
            }
            return new Plan(null, locked.binding(), locked.context(), null, workerRequest(locked, "finalize",
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
            verifySaved(locked);
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
            WorkspaceCsiApplicationImage.verify(inspect(target, locked), WorkspaceCsiApplicationImage.expected(
                    WorkspaceCsiApplicationImage.baseline(authority.frozenBytes()), Stage.DRAINED, authority.frozenBytes(), authority.cutBytes(), receipt));
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
            verifySaved(locked);
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
        var operations = jdbc.query("SELECT * FROM ma_operation WHERE operation_key = ? AND operation_kind = 'CSI_RETIREMENT'",
                (row, index) -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(row),
                WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, retirement));
        require(operations.size() == 1);
        WorkspaceCsiReservationStore.Retirement intent = WorkspaceCsiReservationStore.decodeRetirement(operations.getFirst(), IDENTITY_JSON);
        Snapshot inventory = WorkspaceCsiApplicationInventory.inspect(target, authority.original(), intent);
        if (!inventory.blockers().isEmpty()) {
            throw new RuntimeBrokerException(409, "csi_application_inventory_blocked",
                    "The original CSI application inventory is incomplete or unsupported.", false);
        }
        var parent = WorkspaceCsiApplicationImage.sole(inventory, "ma_session");
        var context = new ContextBinding(tenant, workspace, parent.number("workspace_generation"), parent.text("workspace_storage_id"),
                parent.text("cwd_relative"), parent.text("context_config_ref"), parent.number("context_revision"));
        return new Locked(authority, binding, intent, inventory, context);
    }

    private void verifySaved(Locked locked) throws SQLException {
        var authority = locked.authority();
        if (authority.stage() == Stage.SETTLING) {
            WorkspaceCsiApplicationImage.verify(locked.inventory(), WorkspaceCsiApplicationImage.expected(locked.inventory(), Stage.SETTLING, null, null, null));
            return;
        }
        envelope(locked);
        WorkspaceCsiApplicationImage.verify(locked.inventory(), WorkspaceCsiApplicationImage.expected(
                WorkspaceCsiApplicationImage.baseline(authority.frozenBytes()), authority.stage(), authority.frozenBytes(), authority.cutBytes(), authority.receiptBytes()));
        if (authority.stage() == Stage.DRAINED) {
            var response = CsiFileFinalizeProtocol.response(authority.receiptBytes(), workerRequest(locked, "finalize",
                    hash(savedBody(authority)), hash(authority.frozenBytes()), hash(authority.cutBytes())));
            require(envelope(locked).path("preCutObservationSha256").textValue().equals(response.get("preCutObservationSha256")));
        }
    }

    private JsonNode envelope(Locked locked) {
        var authority = locked.authority();
        return savedEnvelope(locked.binding(), locked.context(), authority.retirementId(),
                authority.sealedBindingVersion(), authority.frozenBytes());
    }

    static JsonNode savedEnvelope(RuntimeBindingRecord binding, ContextBinding context, String retirement,
            long ceiling, byte[] frozenBytes) {
        JsonNode value = WorkspaceCsiApplicationJson.object(frozenBytes, WorkspaceCsiApplicationInventory.MAX_BYTES);
        WorkspaceCsiApplicationJson.closed(value, ENVELOPE_FIELDS);
        byte[] body = WorkspaceCsiApplicationJson.base64(value.path("commitBodyBase64"), 128 * 1024);
        var terminal = ManagedSessionStore.validateCsiTerminalBytes(body);
        require("qwen-csi-application-frozen/1".equals(value.path("format").textValue())
                && retirement.equals(value.path("retirementId").textValue())
                && binding.getBindingId().equals(value.path("bindingId").textValue())
                && binding.getRequest().requestKey().equals(value.path("requestKey").textValue())
                && ceiling > 0 && ceiling <= binding.getVersion()
                && value.path("sealedBindingVersion").isIntegralNumber() && value.path("sealedBindingVersion").longValue() == ceiling
                && WorkspaceCsiRuntimeIdentity.digest(WorkspaceCsiRuntimeIdentity.boot(binding)).equals(value.path("bootSha256").textValue())
                && hash(body).equals(value.path("preparedCommitSha256").textValue())
                && binding.getRequest().getScope().getWorkspaceId().equals(terminal.workspaceId()));
        var observation = WorkspaceCsiApplicationJson.base64(value.path("preCutObservationBase64"), CsiFileFinalizeProtocol.RESPONSE_LIMIT);
        require(hash(observation).equals(value.path("preCutObservationSha256").textValue()));
        var expected = workerRequest(binding, context, retirement, "observe", hash(body), null, null);
        require(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(expected), CsiFileFinalizeProtocol.REQUEST_LIMIT)
                .equals(value.path("workerObserveRequest")));
        CsiFileFinalizeProtocol.response(observation, expected);
        var baseline = WorkspaceCsiApplicationImage.baseline(frozenBytes);
        var head = WorkspaceCsiApplicationImage.sole(baseline, "ma_session_head");
        require(head.text("lease_token_hash").equals(value.path("writerTokenSha256").textValue())
                && terminal.writerId().equals(head.text("writer_id")) && terminal.writerGeneration() == head.number("writer_generation")
                && terminal.expectedJournalRevision() == head.number("journal_revision")
                && terminal.expectedCommittedSequence() == head.number("committed_sequence")
                && java.util.Objects.equals(terminal.previousCommitDigest(), head.text("last_commit_digest")));
        var prepared = WorkspaceCsiApplicationHistory.preparedTerminal(baseline, binding.getRequest(), body);
        WorkspaceCsiApplicationWorkerMatch.verify(baseline, prepared, observation, expected);
        return value;
    }

    private Snapshot inspect(Connection target, Locked locked) throws SQLException {
        return WorkspaceCsiApplicationInventory.inspect(target, locked.authority().original(), locked.intent());
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
                WorkspaceCsiApplicationInventory.MAX_BYTES).path("commitBodyBase64"), 128 * 1024);
    }
    private static boolean same(Object left, Object right) {
        return WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(left), WorkspaceCsiApplicationInventory.MAX_BYTES)
                .equals(WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(right), WorkspaceCsiApplicationInventory.MAX_BYTES));
    }
    private static String encode(byte[] bytes) { return Base64.getEncoder().encodeToString(bytes); }
    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
    private static void digest(String value) { require(value != null && value.matches("[0-9a-f]{64}")); }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "csi_application_retirement_unavailable", "Original CSI application retirement is unavailable.", false);
    }
    private interface Sql<T> { T run(Connection target) throws SQLException; }
    private record Locked(Authority authority, RuntimeBindingRecord binding, WorkspaceCsiReservationStore.Retirement intent,
            Snapshot inventory, ContextBinding context) { }
    private record Plan(Status status, RuntimeBindingRecord binding, ContextBinding context, Snapshot baseline, Map<String, Object> request) { }
}
