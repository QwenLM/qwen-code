package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;

/**
 * The first lock of a tool publication lane, and its read of the original
 * binding (design 2026-11-04-managed-publication-placement).
 *
 * <p>Placement owners lock the original binding and the Session root in both
 * orders: {@code lockBindingControl} takes the binding, then the root;
 * lifecycle verification and hosted cleanup commits take the root, then the
 * binding. A lane without placement therefore locks neither in a fixed
 * position. It locks the Session root first. Every transition out of
 * {@code READY} of a {@code session}-class binding holds that root, so a read
 * after it is current. A {@code workspace}-class binding has no root-holding
 * writers, so the lane shares its row after the root.
 */
final class ToolPublicationPlacement {
    private ToolPublicationPlacement() {
    }

    /**
     * Whether a publication of {@code session} on this original may skip
     * placement: a native, non-CSI, non-Resident original whose binding is
     * either shared by the Workspace or isolated to this same Session.
     */
    static boolean free(JdbcTemplate jdbc, RuntimeBindingRepository bindings,
            RuntimeBindingRecord runtime, String session) {
        if (!(bindings instanceof JdbcRuntimeBindingRepository nativeBindings)
                || !nativeBindings.usesDataSource(jdbc.getDataSource())) {
            return false;
        }
        var request = runtime.getRequest();
        var scope = request.getScope();
        if (WorkspaceCsiReservationStore.PROVISIONER_KIND.equals(request.getProvisionerKind())
                || ResidentWorkspaceProfile.selects(scope)) {
            return false;
        }
        return "workspace".equals(scope.getIsolationClass())
                || "session".equals(scope.getIsolationClass()) && session.equals(request.getIsolationKey());
    }

    /**
     * Takes the lane's first lock: the Session root for a placement-free
     * original, otherwise placement, bounded and named as before (#13800).
     * Returns whether placement was taken; later placement locks of the lane
     * must follow it, because one taken after the root would close a cycle
     * with every placement owner that locks this root.
     */
    static boolean lockEntry(JdbcTemplate jdbc, RuntimeBindingRepository bindings,
            RuntimeBindingRecord runtime, String tenant, String session, boolean requirePlacement) {
        if (!requirePlacement && free(jdbc, bindings, runtime, session)) {
            ToolPublicationRetentionStore.lockSessionRoot(jdbc, tenant, session);
            return false;
        }
        JdbcManagedSessionStore.lockBounded(() -> JdbcWorkspaceLifecycleStore.lockPlacement(jdbc, tenant,
                JdbcManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS));
        return true;
    }

    /**
     * The lane's entry and its current original binding, on the lane's
     * transaction connection: under placement the row is locked for update,
     * as before; a {@code workspace}-class row is shared; a
     * {@code session}-class row is read without a lock, because its writers
     * take the binding before this root and would deadlock against a lock
     * taken after it. The read uses the repository's own connection, so it
     * sees the latest commit whatever the lane's isolation level.
     */
    static RuntimeBindingRecord lockOriginal(JdbcTemplate jdbc, JdbcRuntimeBindingRepository bindings,
            Connection target, RuntimeBindingRecord hint, String session) throws SQLException {
        String bindingId = hint.getBindingId();
        if (lockEntry(jdbc, bindings, hint, hint.getRequest().getScope().getTenantId(), session, false)) {
            return bindings.findByIdForUpdate(target, bindingId);
        }
        if ("workspace".equals(hint.getRequest().getScope().getIsolationClass())) {
            String lock = "H2".equals(target.getMetaData().getDatabaseProductName()) ? " FOR UPDATE" : " FOR SHARE";
            try (PreparedStatement statement = target.prepareStatement(
                    "SELECT binding_id FROM ma_runtime_binding WHERE binding_id = ?" + lock)) {
                // The bound findByIdForUpdate uses for the same row.
                statement.setQueryTimeout(10);
                statement.setBytes(1, bindingId.getBytes(StandardCharsets.UTF_8));
                statement.executeQuery().close();
            }
        }
        return bindings.findById(bindingId);
    }
}
