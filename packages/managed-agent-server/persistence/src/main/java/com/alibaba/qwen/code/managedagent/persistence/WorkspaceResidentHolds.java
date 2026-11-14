package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.springframework.jdbc.core.JdbcTemplate;

import static com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore.busy;

/**
 * Resident-hold verification, split out of WorkspaceExecutionStore. The
 * registration check, held-row SQL and verdict order are the ones the store
 * enforced inline.
 */
final class WorkspaceResidentHolds {
    private WorkspaceResidentHolds() { }

    static void requireResidentHeld(JdbcTemplate jdbc, ResidentWorkspaces residents,
            ContextBinding binding, RuntimeSessionRecord session, boolean releasing) {
        var selected = residents.find(binding);
        if (selected == null || !com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile.selects(session.getSession().getScope())
                || !ResidentWorkspaces.scope(selected).equals(session.getSession().getScope())) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        ResidentWorkspaces.requireRegistration(jdbc, selected);
        var rows = jdbc.query("SELECT rs.runtime_session_id, b.resource_handle_json, o.csi_revision, o.csi_reservation_id"
                + " FROM ma_runtime_session rs"
                + " JOIN ma_runtime_binding b ON b.binding_id = rs.binding_id AND b.runtime_generation = rs.runtime_generation"
                + " JOIN ma_runtime_slot slot ON slot.active_binding_id = b.binding_id AND slot.request_key = b.request_key"
                + " JOIN ma_storage_owner o ON o.binding_id = b.binding_id AND o.runtime_generation = b.runtime_generation"
                + " WHERE rs.binding_id = ? AND rs.runtime_generation = ? AND rs.runtime_session_id = ?"
                + " AND rs.execution_storage_key IS NULL AND rs.is_rewind_pending = FALSE"
                + " AND rs.harness_session_id = ? AND rs.session_state IN (" + (releasing
                        ? "'ACQUIRING', 'READY', 'RELEASING', 'RELEASED'" : "'ACQUIRING', 'READY'") + ")"
                + " AND b.request_key = ? AND b.binding_state = 'READY' AND b.is_drain_requested = FALSE"
                + " AND o.storage_key = ? AND o.storage_kind = 'CSI' AND o.csi_phase = 'RESERVED'"
                + " AND o.csi_registration_key = ? AND o.csi_registration_revision = ?"
                + " AND o.csi_provision_request_id = b.provision_request_id AND o.holder_key IS NULL"
                + " AND o.runtime_session_id IS NULL", (row, index) -> new ResidentHeld(row.getString(1), row.getString(2),
                        row.getLong(3), row.getString(4)), session.getBindingId(), session.getRuntimeGeneration(),
                session.getRuntimeSessionId(), session.getSession().getHarnessSessionId(), residents.request(binding).requestKey(),
                selected.registration().physicalKey(), selected.registration().aliasKey(), selected.registration().revision());
        if (rows.size() != 1 || !session.getRuntimeSessionId().equals(rows.getFirst().sessionId())
                || !jdbc.queryForList("SELECT runtime_session_id FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id <> ? AND session_state <> 'RELEASED'",
                String.class, session.getBindingId(), session.getRuntimeGeneration(), session.getRuntimeSessionId()).isEmpty()) {
            throw busy();
        }
        var held = rows.getFirst();
        var storage = ResidentWorkspaces.heldStorage(held.handle());
        if (!Long.toString(held.revision()).equals(storage.get("reservationRevision"))
                || !held.reservationId().equals(storage.get("reservationId"))) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
    }

    private record ResidentHeld(String sessionId, String handle, long revision, String reservationId) { }
}
