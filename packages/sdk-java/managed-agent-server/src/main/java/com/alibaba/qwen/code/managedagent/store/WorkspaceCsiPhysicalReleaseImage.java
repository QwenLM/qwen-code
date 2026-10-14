package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.require;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Table;
import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Expected ownership delta only; neither a physical receipt nor release authority. */
final class WorkspaceCsiPhysicalReleaseImage {
    private WorkspaceCsiPhysicalReleaseImage() {
    }

    static Snapshot expected(Snapshot drained) {
        require(drained != null && drained.blockers().isEmpty());
        Row binding = WorkspaceCsiApplicationImage.sole(drained, "ma_runtime_binding");
        Row slot = WorkspaceCsiApplicationImage.sole(drained, "ma_runtime_slot");
        Row holder = WorkspaceCsiApplicationImage.sole(drained, "ma_storage_owner");
        require("DRAINING".equals(binding.text("binding_state")) && Boolean.TRUE.equals(binding.bool("drain_requested"))
                && "CSI".equals(holder.text("storage_kind")) && "DRAINING".equals(holder.text("csi_phase"))
                && binding.text("binding_id").equals(slot.text("active_binding_id"))
                && binding.text("binding_id").equals(holder.text("binding_id"))
                && binding.number("runtime_generation") != null && binding.number("runtime_generation") > 0
                && Objects.equals(binding.number("runtime_generation"), slot.number("last_generation"))
                && Objects.equals(binding.number("runtime_generation"), holder.number("runtime_generation"))
                && holder.cell("holder_key").isNull() && holder.cell("runtime_session_id").isNull()
                && holder.cell("maintenance_id").isNull());
        for (String field : List.of("request_key", "tenant_id", "workspace_id", "workspace_generation", "canonical_cwd",
                "capability_digest", "isolation_class", "isolation_key", "provisioner_kind", "storage_id")) {
            require(binding.cell(field).equals(slot.cell(field)));
        }
        for (String field : List.of("csi_reservation_id", "csi_registration_key", "csi_provision_request_id")) {
            require(holder.text(field) != null && !holder.text(field).isEmpty());
        }
        require(holder.number("csi_registration_revision") != null && holder.number("csi_registration_revision") > 0
                && binding.number("record_version") != null && binding.number("record_version") > 0
                && holder.number("csi_revision") != null && CsiOwnershipRevision.draining(holder.number("csi_revision")));

        Map<String, Map<String, byte[]>> changes = new LinkedHashMap<>();
        Map<String, byte[]> bindingDelta = new LinkedHashMap<>();
        put(bindingDelta, "binding_state", "RELEASED");
        put(bindingDelta, "record_version", Math.addExact(binding.number("record_version"), 1L));
        changes.put("ma_runtime_binding", bindingDelta);
        Map<String, byte[]> slotDelta = new LinkedHashMap<>();
        slotDelta.put("active_binding_id", null);
        changes.put("ma_runtime_slot", slotDelta);
        Map<String, byte[]> holderDelta = new LinkedHashMap<>();
        put(holderDelta, "csi_phase", "RELEASED");
        put(holderDelta, "csi_revision", CsiOwnershipRevision.next(holder.number("csi_revision")));
        for (String field : List.of("csi_reservation_id", "csi_registration_key", "csi_registration_revision",
                "binding_id", "runtime_generation", "csi_provision_request_id")) {
            holderDelta.put(field, null);
        }
        changes.put("ma_storage_owner", holderDelta);

        List<Table> tables = new ArrayList<>();
        for (Table table : drained.tables()) {
            List<Row> rows = new ArrayList<>(table.rows());
            if (changes.containsKey(table.name())) {
                Row original = WorkspaceCsiApplicationImage.sole(drained, table.name());
                Map<String, byte[]> values = new LinkedHashMap<>();
                original.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
                values.putAll(changes.get(table.name()));
                rows.set(rows.indexOf(original), WorkspaceCsiApplicationInventory.expectedRow(table.name(), values, original.membership()));
            }
            tables.add(new Table(table.name(), table.columns(), table.primaryKey(), rows));
        }
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    private static void put(Map<String, byte[]> values, String key, Object value) {
        values.put(key, value.toString().getBytes(StandardCharsets.UTF_8));
    }
}
