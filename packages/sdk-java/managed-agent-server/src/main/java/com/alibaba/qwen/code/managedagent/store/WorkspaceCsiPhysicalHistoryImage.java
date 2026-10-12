package com.alibaba.qwen.code.managedagent.store;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.require;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationInventory.Table;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Immutable original read set, independent of the shared holder and unrelated owners. */
final class WorkspaceCsiPhysicalHistoryImage {
    private static final Map<String, Set<String>> CONTEXT = Map.of(
            "qwen_runtime_placement_guard", Set.of("tenant_key", "tenant_id"),
            "qwen_tool_publication_tenant", Set.of("tenant_key", "tenant_id"),
            "managed_workspace_registry", Set.of("tenant_id", "workspace_id", "workspace_generation", "storage_id",
                    "config_ref", "policy_ref", "state"));

    private WorkspaceCsiPhysicalHistoryImage() { }

    static Snapshot expected(Snapshot drained) {
        var released = WorkspaceCsiPhysicalReleaseImage.expected(drained);
        var parent = WorkspaceCsiApplicationImage.sole(released, "managed_agent_session");
        require(parent.text("tenant_id") != null && parent.text("workspace_id") != null);
        List<Table> tables = new ArrayList<>();
        for (Table table : released.tables()) {
            List<Row> rows = new ArrayList<>();
            if (!"managed_workspace_execution_lease".equals(table.name())) {
                for (Row row : table.rows()) {
                    if (row.membership() == Membership.ORIGINAL) {
                        rows.add(row);
                    } else if (CONTEXT.containsKey(table.name())
                            && parent.text("tenant_id").equals(row.text("tenant_id"))
                            && (!"managed_workspace_registry".equals(table.name())
                                    || parent.text("workspace_id").equals(row.text("workspace_id")))) {
                        require(row.membership() == Membership.CONTEXT);
                        Map<String, byte[]> values = new LinkedHashMap<>();
                        row.fields().forEach((name, cell) -> values.put(name,
                                CONTEXT.get(table.name()).contains(name) ? cell.bytes() : null));
                        rows.add(WorkspaceCsiApplicationInventory.expectedRow(table.name(), values, Membership.CONTEXT));
                    }
                }
            }
            tables.add(new Table(table.name(), table.columns(), table.primaryKey(), rows));
        }
        var result = WorkspaceCsiApplicationInventory.expectedImage(tables);
        for (String name : CONTEXT.keySet()) {
            require(result.table(name).rows().size() == 1
                    && result.table(name).rows().getFirst().membership() == Membership.CONTEXT);
        }
        require(JdbcRuntimeBindingRepository.harnessDrainKey(parent.text("tenant_id"))
                .equals(result.table("qwen_runtime_placement_guard").rows().getFirst().text("tenant_key"))
                && CsiNativeActivationProof.sha256(parent.text("tenant_id").getBytes(StandardCharsets.UTF_8))
                        .equals(result.table("qwen_tool_publication_tenant").rows().getFirst().text("tenant_key")));
        var registry = result.table("managed_workspace_registry").rows().getFirst();
        require(parent.cell("workspace_generation").equals(registry.cell("workspace_generation"))
                && parent.cell("workspace_storage_id").equals(registry.cell("storage_id"))
                && parent.cell("workspace_config_ref").equals(registry.cell("config_ref"))
                && parent.cell("workspace_policy_ref").equals(registry.cell("policy_ref"))
                && "ACTIVE".equals(registry.text("state")));
        return result;
    }
}
