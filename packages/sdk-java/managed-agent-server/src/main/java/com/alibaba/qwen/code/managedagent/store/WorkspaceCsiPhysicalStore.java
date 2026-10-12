package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.require;

import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.alibaba.qwen.code.runtimebroker.CsiPodDeletion;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.fasterxml.jackson.databind.JsonNode;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.TimeUnit;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Full original application authority and durable physical progress; no release permission. */
public final class WorkspaceCsiPhysicalStore {
    private static final List<String> COLUMNS = List.of("retirement_id", "binding_id", "physical_key", "record_version", "record_bytes", "record_sha256");
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceCsiApplicationStore application;

    public record Original(String tenantId, String sessionId, String workspaceId, String retirementId) { }
    public record Status(String retirementId, String stage, long version, String planSha256, int deletionAttempts) { }

    record Work(Status status, WorkspaceCsiNodeSourceStore.Association source, byte[] plan, CsiNodeSourceJournal.Evidence previous) {
        Work {
            plan = plan.clone();
        }
        @Override public byte[] plan() { return plan.clone(); }
    }
    record Attempt(Status status, int ordinal, CsiPodDeletion.Request request, boolean send) { }

    public WorkspaceCsiPhysicalStore(JdbcTemplate jdbc, DataSourceTransactionManager manager, WorkspaceCsiApplicationStore application) {
        require(jdbc != null && manager != null && application != null && jdbc.getDataSource() == manager.getDataSource()
                && application.usesDataSource(jdbc.getDataSource()));
        this.jdbc = jdbc;
        this.application = application;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
    }

    public Status status(Original original, String token) {
        return tx(original, token, (target, drained) -> status(read(target, drained)));
    }

    Work plan(Original original, String token, WorkspaceCsiNodeSourceStore.Node node) {
        return tx(original, token, (target, drained) -> {
            var source = WorkspaceCsiNodeSourceStore.lockedPublication(target, drained.binding().getBindingId());
            require(source.configuration().node().equals(node));
            var expected = plan(drained, source);
            var current = read(target, drained);
            if (current == null) {
                current = WorkspaceCsiPhysicalProgress.planned(WorkspaceCsiApplicationJson.encode(expected));
                try (var statement = target.prepareStatement("INSERT INTO managed_workspace_csi_physical"
                        + " (retirement_id,binding_id,physical_key,record_version,record_bytes,record_sha256) VALUES (?,?,?,?,?,?)")) {
                    statement.setString(1, current.retirementId());
                    statement.setString(2, current.bindingId());
                    statement.setString(3, current.physicalKey());
                    statement.setLong(4, current.version());
                    statement.setBytes(5, current.bytes());
                    statement.setString(6, current.sha256());
                    require(statement.executeUpdate() == 1);
                }
                require(Arrays.equals(current.bytes(), Objects.requireNonNull(read(target, drained)).bytes()));
            }
            return new Work(status(current), source, current.planBytes(), current.latestEvidence());
        });
    }

    Status saveIntent(Original original, String token, CsiNodeSourceJournal.Evidence evidence) {
        return mutate(original, token, (current, source) -> current.withIntent(evidence, source));
    }

    Attempt prepareDeletion(Original original, String token, CsiPodDeletion.Request request) {
        return tx(original, token, (target, drained) -> {
            var current = Objects.requireNonNull(read(target, drained));
            var next = current.withAttempt(request);
            save(target, drained, current, next);
            int ordinal = 0;
            for (int index = 1; index <= next.attempts(); index++) {
                if (next.attempt(index).resourceVersion().equals(request.resourceVersion())) {
                    ordinal = index;
                }
            }
            require(ordinal > 0);
            return new Attempt(status(next), ordinal, next.attempt(ordinal), next != current);
        });
    }

    Status saveReply(Original original, String token, int ordinal, CsiPodDeletion.Result result) {
        return mutate(original, token, (current, source) -> current.withReply(ordinal, result));
    }

    Status observe(Original original, String token, CsiNodeSourceJournal.Evidence evidence) {
        return mutate(original, token, (current, source) -> current.withObservation(evidence, source));
    }

    private Status mutate(Original original, String token, Mutation mutation) {
        return tx(original, token, (target, drained) -> {
            var current = Objects.requireNonNull(read(target, drained));
            var source = WorkspaceCsiNodeSourceStore.lockedPublication(target, drained.binding().getBindingId());
            var next = mutation.apply(current, source);
            save(target, drained, current, next);
            return status(next);
        });
    }

    private static void save(Connection target, WorkspaceCsiApplicationStore.Drained drained,
            WorkspaceCsiPhysicalProgress current, WorkspaceCsiPhysicalProgress next) throws SQLException {
        drained.requireConnection(target);
        if (current == next) {
            return;
        }
        require(next.version() == current.version() + 1);
        try (var statement = target.prepareStatement("UPDATE managed_workspace_csi_physical SET record_version=?,record_bytes=?,record_sha256=?"
                + " WHERE retirement_id=? AND binding_id=? AND physical_key=? AND record_version=? AND record_sha256=? AND record_bytes=?")) {
            statement.setLong(1, next.version());
            statement.setBytes(2, next.bytes());
            statement.setString(3, next.sha256());
            statement.setString(4, current.retirementId());
            statement.setString(5, current.bindingId());
            statement.setString(6, current.physicalKey());
            statement.setLong(7, current.version());
            statement.setString(8, current.sha256());
            statement.setBytes(9, current.bytes());
            require(statement.executeUpdate() == 1);
        }
        require(Arrays.equals(next.bytes(), Objects.requireNonNull(read(target, drained)).bytes()));
    }

    static WorkspaceCsiPhysicalProgress read(Connection target, WorkspaceCsiApplicationStore.Drained drained) throws SQLException {
        drained.requireConnection(target);
        try (var statement = catalogue(target, drained.authority().retirementId(), drained.binding().getBindingId(), drained.intent().physicalKey());
                var rows = statement.executeQuery()) {
            schema(rows);
            if (!rows.next()) {
                return null;
            }
            require(drained.authority().retirementId().equals(rows.getString("retirement_id"))
                    && drained.binding().getBindingId().equals(rows.getString("binding_id"))
                    && drained.intent().physicalKey().equals(rows.getString("physical_key")));
            long version = rows.getLong("record_version");
            require(!rows.wasNull());
            byte[] bytes;
            try (var input = rows.getBinaryStream("record_bytes")) {
                require(input != null);
                bytes = input.readNBytes(WorkspaceCsiPhysicalProgress.LIMIT + 1);
            } catch (java.io.IOException failure) {
                throw new SQLException("Original CSI physical progress bytes are unavailable", failure);
            }
            var source = WorkspaceCsiNodeSourceStore.lockedPublication(target, drained.binding().getBindingId());
            var result = WorkspaceCsiPhysicalProgress.restore(version, bytes, rows.getString("record_sha256"), plan(drained, source), source);
            require(!rows.next());
            return result;
        }
    }

    static void requireEmpty(Connection target, String retirement, String binding, String physical) throws SQLException {
        try (var statement = catalogue(target, retirement, binding, physical); var rows = statement.executeQuery()) {
            schema(rows);
            require(!rows.next());
        }
    }

    private static java.sql.PreparedStatement catalogue(Connection target, String retirement, String binding, String physical) throws SQLException {
        require(target != null && !target.getAutoCommit());
        var statement = target.prepareStatement("SELECT * FROM managed_workspace_csi_physical WHERE retirement_id=? OR binding_id=?"
                + " OR physical_key=? ORDER BY retirement_id LIMIT 2 FOR UPDATE");
        statement.setString(1, retirement);
        statement.setString(2, binding);
        statement.setString(3, physical);
        return statement;
    }

    private static void schema(ResultSet rows) throws SQLException {
        var metadata = rows.getMetaData();
        require(metadata.getColumnCount() == COLUMNS.size());
        for (int index = 0; index < COLUMNS.size(); index++) {
            int type = metadata.getColumnType(index + 1);
            require(COLUMNS.get(index).equals(metadata.getColumnName(index + 1).toLowerCase(java.util.Locale.ROOT))
                    && switch (index) {
                        case 0, 2, 5 -> type == Types.CHAR;
                        case 1 -> type == Types.VARCHAR;
                        case 3 -> type == Types.BIGINT;
                        case 4 -> type == Types.BLOB || type == Types.LONGVARBINARY;
                        default -> false;
                    });
        }
    }

    private static JsonNode plan(WorkspaceCsiApplicationStore.Drained drained, WorkspaceCsiNodeSourceStore.Association source) {
        var binding = drained.binding();
        var intent = drained.intent();
        var authority = drained.authority();
        var observed = WorkspaceCsiNodeSourceStore.validateEvidence(source.configuration(), source.publication(), "PUBLISHED", source.podUid());
        var placement = WorkspaceCsiRuntimeIdentity.map(binding.getResourceHandle().getValue().get("placement"));
        require(source.bindingId().equals(binding.getBindingId()) && source.physicalKey().equals(intent.physicalKey())
                && source.reservationId().equals(intent.reservation().reservationId())
                && source.reservationRevision() == intent.reservation().revision()
                && source.podUid().equals(placement.get("podUid")) && source.configuration().node().name().equals(placement.get("nodeName"))
                && source.configuration().node().identity().nodeUid().equals(placement.get("nodeUid"))
                && ("containerd://" + observed.scope().containerId()).equals(placement.get("containerId"))
                && source.configuration().scope().namespace().equals(placement.get("namespace"))
                && source.configuration().scope().podName().equals(placement.get("podName"))
                && placement.get("image").toString().endsWith("@sha256:" + source.configuration().imageDigest()));
        var value = new LinkedHashMap<String, Object>();
        value.put("format", "qwen-csi-physical-plan/2");
        value.put("retirementId", authority.retirementId());
        value.put("bindingId", binding.getBindingId());
        value.put("physicalKey", intent.physicalKey());
        value.put("registrationRevision", Long.toString(intent.reservation().registrationRevision()));
        value.put("requestKey", authority.original().request().requestKey());
        value.put("sealedBindingVersion", Long.toString(authority.sealedBindingVersion()));
        value.put("bootSha256", WorkspaceCsiRuntimeIdentity.digest(WorkspaceCsiRuntimeIdentity.boot(binding)));
        value.put("drainedInventorySha256", hash(drained.inventory().bytes()));
        value.put("ownershipReleaseInventorySha256", hash(WorkspaceCsiPhysicalReleaseImage.expected(drained.inventory()).bytes()));
        value.put("identitySha256", hash(WorkspaceCsiApplicationImage.sole(drained.inventory(), "managed_workspace_csi_retirement").cell("identity_json").bytes()));
        value.put("baselineSha256", hash(WorkspaceCsiApplicationImage.baseline(authority.frozenBytes()).bytes()));
        value.put("frozenRequestSha256", hash(authority.frozenBytes()));
        value.put("cutSha256", hash(authority.cutBytes()));
        value.put("finalizeReceiptSha256", hash(authority.receiptBytes()));
        value.put("sourceRowSha256", hash(WorkspaceCsiApplicationImage.sole(drained.inventory(), "managed_workspace_csi_source").bytes()));
        value.put("sourceConfigurationBase64", java.util.Base64.getEncoder().encodeToString(WorkspaceCsiApplicationJson.encode(source.configuration())));
        value.put("sourceScope", observed.scope());
        value.put("publicationSha256", hash(source.publication().bytes()));
        value.put("publicationHead", source.publication().stream().head());
        value.put("namespace", placement.get("namespace"));
        value.put("podName", placement.get("podName"));
        value.put("podUid", placement.get("podUid"));
        value.put("podSpecDigest", binding.getResourceHandle().getValue().get("podSpecDigest"));
        value.put("protection", binding.getResourceHandle().getValue().get("protection"));
        return WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.encode(value), 64 * 1024);
    }

    private <T> T tx(Original original, String token, WorkSql<T> work) {
        require(original != null && !TransactionSynchronizationManager.isActualTransactionActive());
        long started = System.nanoTime();
        return transaction.execute(status -> jdbc.execute((ConnectionCallback<T>) actual -> {
            var target = DataSourceUtils.getTargetConnection(actual);
            require(!target.getAutoCommit() && DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource()));
            var connection = WorkspaceCsiApplicationStore.bounded(target, started);
            var drained = application.lockDrained(connection, original.tenantId(), original.sessionId(), original.workspaceId(), original.retirementId(), token);
            T result = work.apply(connection, drained);
            require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
            return result;
        }));
    }

    private static Status status(WorkspaceCsiPhysicalProgress value) {
        require(value != null);
        return new Status(value.retirementId(), value.stage(), value.version(), value.planSha256(), value.attempts());
    }
    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
    private interface WorkSql<T> { T apply(Connection target, WorkspaceCsiApplicationStore.Drained drained) throws SQLException; }
    private interface Mutation { WorkspaceCsiPhysicalProgress apply(WorkspaceCsiPhysicalProgress current, WorkspaceCsiNodeSourceStore.Association source); }
}
