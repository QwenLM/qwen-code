package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Table;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

/** Original application image with stable shared workspace context. */
final class WorkspaceCsiApplicationHistoryImage {
    private static final Map<String, Set<String>> CONTEXT = Map.of(
            "ma_tenant_guard", Set.of("tenant_key", "tenant_id", "guard_domain"),
            "ma_workspace", Set.of("tenant_id", "workspace_id", "workspace_generation", "storage_id",
                    "config_ref", "policy_ref", "state", "workspace_kind", "child_state", "parent_workspace_id",
                    "parent_session_id", "child_run_id", "child_workspace_id", "parent_cwd_relative", "repository_relative",
                    "child_cwd_relative", "base_commit", "result_commit", "parent_tree", "merged_tree", "finish_request",
                    "outcome_code", "conflict_paths", "last_error"));

    private WorkspaceCsiApplicationHistoryImage() { }

    static Snapshot owner(Snapshot stage) {
        var parent = WorkspaceCsiApplicationImage.sole(stage, "ma_session");
        require(parent.text("tenant_id") != null && parent.text("workspace_id") != null);
        List<Table> tables = new ArrayList<>();
        for (Table table : stage.tables()) {
            List<Row> rows = new ArrayList<>();
            for (Row row : table.rows()) {
                if (row.membership() == Membership.ORIGINAL) {
                    rows.add(row);
                } else if (CONTEXT.containsKey(table.name())
                        && parent.text("tenant_id").equals(row.text("tenant_id"))
                        && (!"ma_workspace".equals(table.name())
                                || parent.text("workspace_id").equals(row.text("workspace_id")))) {
                    require(row.membership() == Membership.CONTEXT);
                    rows.add(context(table.name(), row));
                }
            }
            tables.add(new Table(table.name(), table.columns(), table.primaryKey(), rows));
        }
        var result = WorkspaceCsiApplicationInventory.expectedImage(tables);
        require(result.table("ma_workspace").rows().size() == 1
                && result.table("ma_workspace").rows().getFirst().membership() == Membership.CONTEXT);
        var guards = result.table("ma_tenant_guard").rows();
        require(guards.size() == 2);
        for (String domain : List.of("runtime_placement", "output_publication")) {
            var found = guards.stream().filter(row -> domain.equals(row.text("guard_domain"))).toList();
            require(found.size() == 1 && found.getFirst().membership() == Membership.CONTEXT
                    && JdbcRuntimeBindingRepository.harnessDrainKey(parent.text("tenant_id")).equals(found.getFirst().text("tenant_key")));
        }
        var registry = result.table("ma_workspace").rows().getFirst();
        require(parent.cell("workspace_generation").equals(registry.cell("workspace_generation"))
                && parent.cell("workspace_storage_id").equals(registry.cell("storage_id"))
                && parent.cell("workspace_config_ref").equals(registry.cell("config_ref"))
                && parent.cell("workspace_policy_ref").equals(registry.cell("policy_ref"))
                && "ACTIVE".equals(registry.text("state")));
        return result;
    }

    static Row context(String table, Row row) {
        require(CONTEXT.containsKey(table));
        Map<String, byte[]> values = new LinkedHashMap<>();
        row.fields().forEach((name, cell) -> values.put(name,
                CONTEXT.get(table).contains(name) ? cell.bytes() : null));
        return WorkspaceCsiApplicationInventory.expectedRow(table, values, Membership.CONTEXT);
    }
}
