package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Function;

/** 持久化候选行的完整性校验，供写入和受控恢复共用。 */
public final class ManagedSchemaIntegrity {
    private record Rule(String name, Function<Map<String, ?>, Boolean> predicate) {}

    private static final Set<String> DOMAIN_SESSION_SESSION_KIND =
            Set.of("PUBLIC", "CONTROL");
    private static final Set<String> DOMAIN_SESSION_SELECTED_APPROVAL_MODE =
            Set.of("default", "auto", "auto-edit", "yolo");
    private static final Set<String> DOMAIN_SESSION_HARNESS_PLACEMENT_STATE =
            Set.of("ACTIVE", "QUIESCING", "RELEASED");
    private static final Set<String> DOMAIN_SESSION_HEAD_HEAD_KIND =
            enumNames(ManagedSchemaContract.HeadKind.values());
    private static final Set<String> DOMAIN_EVENT_STREAM_STREAM_KIND =
            Set.of("SESSION", "TASK");
    private static final Set<String> DOMAIN_SESSION_RECORD_RECORD_KIND =
            Set.of("DOMAIN", "ACTION");
    private static final Set<String> DOMAIN_RESOURCE_REF_OWNER_KIND =
            enumNames(ManagedSchemaContract.ResourceOwnerKind.values());
    private static final Set<String> DOMAIN_REQUEST_RECEIPT_NAMESPACE =
            enumNames(ManagedSchemaContract.ReceiptNamespace.values());
    private static final Set<String> DOMAIN_REQUEST_RECEIPT_SCOPE_KIND =
            enumNames(ManagedSchemaContract.ReceiptScope.values());
    private static final Set<String> DOMAIN_OPERATION_EXECUTION_MODE =
            Set.of("SYNC", "ASYNC");
    private static final Set<String> DOMAIN_OPERATION_OPERATION_KIND =
            enumNames(ManagedSchemaContract.OperationKind.values());
    private static final Set<String> DOMAIN_OPERATION_WORK_WORK_KIND =
            enumNames(ManagedSchemaContract.WorkKind.values());
    private static final Set<String> DOMAIN_WORKSPACE_STATE =
            Set.of("ACTIVE", "DRAINING", "REMOVED");
    private static final Set<String> DOMAIN_WORKSPACE_WORKSPACE_KIND =
            Set.of("ROOT", "CHILD_GIT");
    private static final Set<String> DOMAIN_WORKSPACE_ACCESS_ROLE =
            Set.of("READER", "OPERATOR", "OWNER");
    private static final Set<String> DOMAIN_EXTENSION_PACKAGE_STATE =
            Set.of("PREPARING", "PUBLISHED");
    private static final Set<String> DOMAIN_EXTENSION_OPERATION_OPERATION_KIND =
            Set.of("publish", "settings");
    private static final Set<String> DOMAIN_EXTENSION_OPERATION_STATE =
            Set.of("pending", "settled");
    private static final Set<String> DOMAIN_STORAGE_REGISTRATION_STATE =
            Set.of("FENCE_ONLY", "REGISTERED", "RETIRING", "RETIRED");
    private static final Set<String> DOMAIN_TENANT_GUARD_GUARD_DOMAIN =
            Set.of("runtime_placement", "output_publication");
    private static final Set<String> DOMAIN_DELIVERY_DELIVERY_KIND =
            enumNames(ManagedSchemaContract.DeliveryKind.values());
    private static final Set<String> DOMAIN_SESSION_WORKTREE_STATE =
            Set.of("PREPARING", "READY", "FAILED", "BLOCKED", "REMOVING", "REMOVED");

    private static final Map<String, List<Rule>> RULES = Map.ofEntries(
            Map.entry("ma_session", List.of(
                    new Rule("ck_ma_session_kind", row ->
                            domain(row.get("session_kind"), DOMAIN_SESSION_SESSION_KIND)),
                    new Rule("ck_ma_session_resource_gc", row ->
                            booleanValue(row.get("is_resource_gc_completed"))),
                    new Rule("ck_ma_public_agent", row ->
                            or(eq(row.get("session_kind"), "CONTROL"), present(row.get("agent_id")))),
                    new Rule("ck_ma_session_binding", row ->
                            or(
                                    eq(row.get("session_kind"), "CONTROL"),
                                    and(
                                            absent(row.get("workspace_id")),
                                            absent(row.get("workspace_generation")),
                                            absent(row.get("workspace_storage_id")),
                                            absent(row.get("cwd_relative")),
                                            absent(row.get("context_config_ref")),
                                            absent(row.get("context_revision")),
                                            absent(row.get("workspace_config_ref")),
                                            absent(row.get("workspace_policy_ref"))
                                    ),
                                    and(
                                            present(row.get("workspace_id")),
                                            present(row.get("workspace_generation")),
                                            gt(row.get("workspace_generation"), 0L),
                                            present(row.get("workspace_storage_id")),
                                            present(row.get("cwd_relative")),
                                            present(row.get("context_config_ref")),
                                            present(row.get("context_revision")),
                                            gt(row.get("context_revision"), 0L),
                                            present(row.get("workspace_config_ref")),
                                            present(row.get("workspace_policy_ref"))
                                    )
                            )),
                    new Rule("ck_ma_session_model_selection", row ->
                            or(
                                    and(absent(row.get("model_id")), eq(row.get("model_revision"), 0L)),
                                    and(
                                            present(row.get("model_id")),
                                            ge(row.get("model_revision"), 1L),
                                            le(row.get("model_revision"), 9007199254740991L)
                                    )
                            )),
                    new Rule("ck_ma_session_approval_selection", row ->
                            or(
                                    and(
                                            absent(row.get("selected_approval_mode")),
                                            eq(row.get("approval_revision"), 0L)
                                    ),
                                    and(
                                            present(row.get("selected_approval_mode")),
                                            ge(row.get("approval_revision"), 1L),
                                            le(row.get("approval_revision"), 9007199254740991L),
                                            domain(
                                                    row.get("selected_approval_mode"),
                                                    DOMAIN_SESSION_SELECTED_APPROVAL_MODE
                                            )
                                    )
                            )),
                    new Rule("ck_ma_session_permission_rules", row ->
                            or(
                                    absent(row.get("permission_rules_json")),
                                    and(
                                            present(row.get("selected_approval_mode")),
                                            ge(row.get("approval_revision"), 1L),
                                            le(octets(row.get("permission_rules_json")), 8192L)
                                    )
                            )),
                    new Rule("ck_ma_session_plan", row ->
                            or(
                                    eq(row.get("is_plan_enabled"), 0L),
                                    and(
                                            present(row.get("selected_approval_mode")),
                                            ge(row.get("approval_revision"), 1L)
                                    )
                            )),
                    new Rule("ck_ma_public_child_agents", row ->
                            and(
                                    ge(row.get("public_child_agents_version"), 0L),
                                    le(row.get("public_child_agents_version"), 1L)
                            )),
                    new Rule("ck_ma_harness_placement", row ->
                            or(
                                    and(
                                            eq(row.get("harness_placement_state"), "UNASSIGNED"),
                                            absent(row.get("harness_instance_id")),
                                            absent(row.get("harness_owner_boot_id")),
                                            eq(row.get("harness_placement_epoch"), 0L)
                                    ),
                                    and(
                                            present(row.get("harness_instance_id")),
                                            present(row.get("harness_owner_boot_id")),
                                            gt(row.get("harness_placement_epoch"), 0L),
                                            domain(
                                                    row.get("harness_placement_state"),
                                                    DOMAIN_SESSION_HARNESS_PLACEMENT_STATE
                                            )
                                    )
                            )),
                    new Rule("ck_ma_session_boolean_values", row ->
                            and(
                                    ge(row.get("is_recovery_protected"), 0L),
                                    le(row.get("is_recovery_protected"), 1L),
                                    ge(row.get("is_resource_gc_completed"), 0L),
                                    le(row.get("is_resource_gc_completed"), 1L),
                                    ge(row.get("is_csi_guard"), 0L),
                                    le(row.get("is_csi_guard"), 1L),
                                    ge(row.get("is_plan_enabled"), 0L),
                                    le(row.get("is_plan_enabled"), 1L)
                            )))),
            Map.entry("ma_user_message_queue", List.of(
                    new Rule("ck_ma_user_message_queue_boolean_values", row ->
                            and(ge(row.get("is_paused"), 0L), le(row.get("is_paused"), 1L))))),
            Map.entry("ma_turn", List.of(
                    new Rule("ck_ma_turn_model_selection", row ->
                            or(
                                    and(absent(row.get("model_id")), absent(row.get("model_revision"))),
                                    and(
                                            present(row.get("model_id")),
                                            present(row.get("model_revision")),
                                            ge(row.get("model_revision"), 1L),
                                            le(row.get("model_revision"), 9007199254740991L)
                                    )
                            )),
                    new Rule("ck_ma_turn_approval_selection", row ->
                            or(
                                    and(absent(row.get("approval_mode")), absent(row.get("approval_revision"))),
                                    and(
                                            present(row.get("approval_mode")),
                                            present(row.get("approval_revision")),
                                            ge(row.get("approval_revision"), 0L),
                                            le(row.get("approval_revision"), 9007199254740991L),
                                            domain(
                                                    row.get("approval_mode"),
                                                    DOMAIN_SESSION_SELECTED_APPROVAL_MODE
                                            )
                                    )
                            )),
                    new Rule("ck_ma_turn_permission_rules", row ->
                            or(
                                    absent(row.get("permission_rules_json")),
                                    and(
                                            present(row.get("approval_mode")),
                                            ge(row.get("approval_revision"), 1L),
                                            le(octets(row.get("permission_rules_json")), 8192L)
                                    )
                            )),
                    new Rule("ck_ma_turn_plan", row ->
                            or(
                                    absent(row.get("is_plan_enabled")),
                                    and(
                                            present(row.get("approval_mode")),
                                            present(row.get("approval_revision")),
                                            or(
                                                    eq(row.get("is_plan_enabled"), 0L),
                                                    ge(row.get("approval_revision"), 1L)
                                            )
                                    )
                            )),
                    new Rule("ck_ma_turn_boolean_values", row ->
                            and(
                                    ge(row.get("is_submission_attempted"), 0L),
                                    le(row.get("is_submission_attempted"), 1L),
                                    ge(row.get("is_plan_enabled"), 0L),
                                    le(row.get("is_plan_enabled"), 1L)
                            )))),
            Map.entry("ma_session_head", List.of(
                    new Rule("ck_ma_head_kind", row ->
                            domain(row.get("head_kind"), DOMAIN_SESSION_HEAD_HEAD_KIND)),
                    new Rule("ck_ma_head_journal", row ->
                            or(
                                    and(
                                            eq(row.get("head_kind"), "HARNESS"),
                                            absent(row.get("journal_revision")),
                                            absent(row.get("committed_sequence")),
                                            absent(row.get("writer_generation")),
                                            absent(row.get("activation_epoch")),
                                            absent(row.get("storage_version"))
                                    ),
                                    and(
                                            eq(row.get("head_kind"), "MANAGED_SESSION"),
                                            present(row.get("journal_revision")),
                                            present(row.get("committed_sequence")),
                                            present(row.get("writer_generation")),
                                            present(row.get("activation_epoch")),
                                            present(row.get("storage_version"))
                                    )
                            )),
                    new Rule("ck_ma_head_counters", row ->
                            and(
                                    ge(row.get("claim_generation"), 0L),
                                    or(
                                            absent(row.get("writer_generation")),
                                            ge(row.get("writer_generation"), 0L)
                                    ),
                                    or(absent(row.get("activation_epoch")), ge(row.get("activation_epoch"), 0L))
                            )),
                    new Rule("ck_ma_session_head_boolean_values", row ->
                            and(
                                    ge(row.get("is_wake_pending"), 0L),
                                    le(row.get("is_wake_pending"), 1L),
                                    ge(row.get("is_wake_scan_pending"), 0L),
                                    le(row.get("is_wake_scan_pending"), 1L)
                            )))),
            Map.entry("ma_session_journal_tx", List.of(
                    new Rule("ck_ma_activation_lease", row ->
                            or(
                                    and(
                                            absent(row.get("activation_lease_until")),
                                            absent(row.get("activation_renewal_seq"))
                                    ),
                                    and(
                                            present(row.get("activation_lease_until")),
                                            le(row.get("activation_lease_until"), 9007199254740991L),
                                            present(row.get("activation_renewal_seq")),
                                            gt(row.get("activation_renewal_seq"), 0L),
                                            le(row.get("activation_renewal_seq"), 9007199254740991L)
                                    )
                            )))),
            Map.entry("ma_event_stream", List.of(
                    new Rule("ck_ma_stream_kind", row ->
                            domain(row.get("stream_kind"), DOMAIN_EVENT_STREAM_STREAM_KIND)),
                    new Rule("ck_ma_stream_counters", row ->
                            and(
                                    ge(row.get("last_sequence"), 0L),
                                    ge(row.get("replay_floor_sequence"), 0L),
                                    le(row.get("replay_floor_sequence"), row.get("last_sequence")),
                                    ge(row.get("covered_sequence"), 0L),
                                    le(row.get("covered_sequence"), row.get("last_sequence"))
                            )),
                    new Rule("ck_ma_stream_wake", row ->
                            or(
                                    absent(row.get("wake_covered_sequence")),
                                    and(
                                            eq(row.get("stream_kind"), "SESSION"),
                                            ge(row.get("wake_covered_sequence"), 0L)
                                    )
                            )),
                    new Rule("ck_ma_event_stream_boolean_values", row ->
                            and(
                                    ge(row.get("is_projection_pending"), 0L),
                                    le(row.get("is_projection_pending"), 1L)
                            )))),
            Map.entry("ma_public_event", List.of(
                    new Rule("ck_ma_event_session_payload", row ->
                            or(
                                    eq(row.get("stream_kind"), "TASK"),
                                    and(present(row.get("data_json")), present(row.get("is_terminal")))
                            )),
                    new Rule("ck_ma_event_stream", row ->
                            domain(row.get("stream_kind"), DOMAIN_EVENT_STREAM_STREAM_KIND)),
                    new Rule("ck_ma_public_event_boolean_values", row ->
                            and(
                                    ge(row.get("is_terminal"), 0L),
                                    le(row.get("is_terminal"), 1L),
                                    ge(row.get("is_truncated"), 0L),
                                    le(row.get("is_truncated"), 1L),
                                    ge(row.get("is_archived"), 0L),
                                    le(row.get("is_archived"), 1L)
                            )))),
            Map.entry("ma_message", List.of(
                    new Rule("ck_ma_message_revision", row ->
                            gt(row.get("revision"), 0L)))),
            Map.entry("ma_session_record", List.of(
                    new Rule("ck_ma_record_kind", row ->
                            domain(row.get("record_kind"), DOMAIN_SESSION_RECORD_RECORD_KIND)),
                    new Rule("ck_ma_record_role", row ->
                            or(
                                    and(
                                            eq(row.get("record_kind"), "DOMAIN"),
                                            present(row.get("workspace_id")),
                                            present(row.get("record_resource_id"))
                                    ),
                                    and(
                                            eq(row.get("record_kind"), "ACTION"),
                                            present(row.get("action_id")),
                                            present(row.get("action_version")),
                                            present(row.get("options_json"))
                                    )
                            )))),
            Map.entry("ma_resource", List.of(
                    new Rule("ck_ma_resource_length", row ->
                            ge(row.get("byte_length"), 0L)),
                    new Rule("ck_ma_resource_capture", row ->
                            or(
                                    and(
                                            absent(row.get("publication_id")),
                                            absent(row.get("scope_key")),
                                            absent(row.get("slot_key")),
                                            absent(row.get("capture_state"))
                                    ),
                                    and(
                                            present(row.get("publication_id")),
                                            present(row.get("scope_key")),
                                            present(row.get("slot_key")),
                                            present(row.get("capture_state"))
                                    )
                            )))),
            Map.entry("ma_resource_ref", List.of(
                    new Rule("ck_ma_ref_owner", row ->
                            domain(row.get("owner_kind"), DOMAIN_RESOURCE_REF_OWNER_KIND)),
                    new Rule("ck_ma_ref_binding", row ->
                            or(
                                    and(
                                            eq(row.get("owner_kind"), "HOSTED_CLEANUP"),
                                            present(row.get("runtime_binding_key")),
                                            gt(row.get("owner_revision"), 0L)
                                    ),
                                    and(
                                            ne(row.get("owner_kind"), "HOSTED_CLEANUP"),
                                            absent(row.get("runtime_binding_key"))
                                    )
                            )))),
            Map.entry("ma_output_capture", List.of(
                    new Rule("ck_ma_output_capture_boolean_values", row ->
                            and(
                                    ge(row.get("is_quarantined"), 0L),
                                    le(row.get("is_quarantined"), 1L),
                                    ge(row.get("is_write_evidence"), 0L),
                                    le(row.get("is_write_evidence"), 1L),
                                    ge(row.get("is_accepted_complete"), 0L),
                                    le(row.get("is_accepted_complete"), 1L)
                            )))),
            Map.entry("ma_request_receipt", List.of(
                    new Rule("ck_ma_request_namespace", row ->
                            domain(row.get("namespace"), DOMAIN_REQUEST_RECEIPT_NAMESPACE)),
                    new Rule("ck_ma_request_scope", row ->
                            domain(row.get("scope_kind"), DOMAIN_REQUEST_RECEIPT_SCOPE_KIND)),
                    new Rule("ck_ma_request_receipt_boolean_values", row ->
                            and(ge(row.get("is_workspace_bound"), 0L), le(row.get("is_workspace_bound"), 1L))))),
            Map.entry("ma_operation", List.of(
                    new Rule("ck_ma_operation_generation", row ->
                            and(
                                    ge(row.get("claim_generation"), 0L),
                                    ge(row.get("attempt_count"), 0L),
                                    gt(row.get("payload_version"), 0L)
                            )),
                    new Rule("ck_ma_operation_mode", row ->
                            domain(row.get("execution_mode"), DOMAIN_OPERATION_EXECUTION_MODE)),
                    new Rule("ck_ma_operation_kind", row ->
                            domain(row.get("operation_kind"), DOMAIN_OPERATION_OPERATION_KIND)),
                    new Rule("ck_ma_operation_boolean_values", row ->
                            and(
                                    ge(row.get("is_verification_ready"), 0L),
                                    le(row.get("is_verification_ready"), 1L)
                            )))),
            Map.entry("ma_operation_work", List.of(
                    new Rule("ck_ma_work_kind", row ->
                            domain(row.get("work_kind"), DOMAIN_OPERATION_WORK_WORK_KIND)))),
            Map.entry("ma_workspace", List.of(
                    new Rule("ck_ma_workspace_generation", row ->
                            gt(row.get("workspace_generation"), 0L)),
                    new Rule("ck_ma_workspace_state", row ->
                            domain(row.get("state"), DOMAIN_WORKSPACE_STATE)),
                    new Rule("ck_ma_workspace_kind", row ->
                            domain(row.get("workspace_kind"), DOMAIN_WORKSPACE_WORKSPACE_KIND)),
                    new Rule("ck_ma_workspace_default", row ->
                            or(eq(row.get("is_default"), 0L), eq(row.get("workspace_kind"), "ROOT"))),
                    new Rule("ck_ma_workspace_boolean_values", row ->
                            and(ge(row.get("is_default"), 0L), le(row.get("is_default"), 1L))))),
            Map.entry("ma_workspace_access", List.of(
                    new Rule("ck_ma_access_role", row ->
                            domain(row.get("role"), DOMAIN_WORKSPACE_ACCESS_ROLE)))),
            Map.entry("ma_extension_package", List.of(
                    new Rule("ck_ma_extension_package_revision", row ->
                            gt(row.get("package_revision"), 0L)),
                    new Rule("ck_ma_extension_package_bytes", row ->
                            and(ge(row.get("byte_length"), 0L), le(row.get("byte_length"), 104857600L))),
                    new Rule("ck_ma_extension_package_state", row ->
                            domain(row.get("state"), DOMAIN_EXTENSION_PACKAGE_STATE)))),
            Map.entry("ma_extension_settings", List.of(
                    new Rule("ck_ma_extension_settings_revision", row ->
                            gt(row.get("settings_revision"), 0L)))),
            Map.entry("ma_extension_operation", List.of(
                    new Rule("ck_ma_extension_operation_revision", row ->
                            gt(row.get("revision"), 0L)),
                    new Rule("ck_ma_extension_operation_kind", row ->
                            domain(row.get("operation_kind"), DOMAIN_EXTENSION_OPERATION_OPERATION_KIND)),
                    new Rule("ck_ma_extension_operation_state", row ->
                            domain(row.get("state"), DOMAIN_EXTENSION_OPERATION_STATE)))),
            Map.entry("ma_storage", List.of(
                    new Rule("ck_ma_storage_registration", row ->
                            domain(row.get("registration_state"), DOMAIN_STORAGE_REGISTRATION_STATE)),
                    new Rule("ck_ma_storage_registered", row ->
                            or(
                                    eq(row.get("registration_state"), "FENCE_ONLY"),
                                    and(
                                            present(row.get("physical_key")),
                                            present(row.get("registration_revision")),
                                            present(row.get("registration_json"))
                                    )
                            )))),
            Map.entry("ma_runtime_binding", List.of(
                    new Rule("ck_ma_runtime_binding_boolean_values", row ->
                            and(
                                    ge(row.get("is_provision_seeded"), 0L),
                                    le(row.get("is_provision_seeded"), 1L),
                                    ge(row.get("is_drain_requested"), 0L),
                                    le(row.get("is_drain_requested"), 1L)
                            )))),
            Map.entry("ma_runtime_session", List.of(
                    new Rule("ck_ma_runtime_session_boolean_values", row ->
                            and(
                                    ge(row.get("is_execution_exclusive"), 0L),
                                    le(row.get("is_execution_exclusive"), 1L)
                            )))),
            Map.entry("ma_tool_execution", List.of(
                    new Rule("ck_ma_tool_execution_boolean_values", row ->
                            and(ge(row.get("is_cancel_requested"), 0L), le(row.get("is_cancel_requested"), 1L))))),
            Map.entry("ma_tenant_guard", List.of(
                    new Rule("ck_ma_guard_domain", row ->
                            domain(row.get("guard_domain"), DOMAIN_TENANT_GUARD_GUARD_DOMAIN)))),
            Map.entry("ma_read_lease", List.of(
                    new Rule("ck_ma_read_generation", row ->
                            ge(row.get("retirement_generation"), 0L)))),
            Map.entry("ma_delivery", List.of(
                    new Rule("ck_ma_delivery_kind", row ->
                            domain(row.get("delivery_kind"), DOMAIN_DELIVERY_DELIVERY_KIND)),
                    new Rule("ck_ma_delivery_source", row ->
                            or(eq(row.get("delivery_kind"), "CHANNEL"), present(row.get("source_session_id")))),
                    new Rule("ck_ma_delivery_claim_source", row ->
                            or(absent(row.get("claimed_at")), present(row.get("source_session_id")))),
                    new Rule("ck_ma_delivery_generation", row ->
                            and(ge(row.get("claim_generation"), 0L), ge(row.get("attempt_count"), 0L))))),
            Map.entry("ma_schedule", List.of(
                    new Rule("ck_ma_schedule_boolean_values", row ->
                            and(ge(row.get("is_enabled"), 0L), le(row.get("is_enabled"), 1L))))),
            Map.entry("ma_session_worktree", List.of(
                    new Rule("ck_ma_session_worktree_state", row ->
                            domain(row.get("state"), DOMAIN_SESSION_WORKTREE_STATE)),
                    new Rule("ck_ma_session_worktree_revision", row ->
                            gt(row.get("revision"), 0L)))),
            Map.entry("ma_session_principal", List.of(
                    new Rule("ck_ma_session_principal_actor_present", row ->
                            and(ge(row.get("is_actor_present"), 0L), le(row.get("is_actor_present"), 1L))))));

    private static final Map<String, Set<String>> FIELDS = Map.ofEntries(
            Map.entry("ma_session", Set.of(
                    "agent_id",
                    "approval_revision",
                    "context_config_ref",
                    "context_revision",
                    "cwd_relative",
                    "harness_instance_id",
                    "harness_owner_boot_id",
                    "harness_placement_epoch",
                    "harness_placement_state",
                    "is_plan_enabled",
                    "is_recovery_protected",
                    "is_resource_gc_completed",
                    "model_id",
                    "model_revision",
                    "permission_rules_json",
                    "public_child_agents_version",
                    "selected_approval_mode",
                    "session_kind",
                    "workspace_config_ref",
                    "workspace_generation",
                    "workspace_id",
                    "workspace_policy_ref",
                    "workspace_storage_id")),
            Map.entry("ma_user_message_queue", Set.of(
                    "is_paused")),
            Map.entry("ma_turn", Set.of(
                    "approval_mode",
                    "approval_revision",
                    "is_plan_enabled",
                    "is_submission_attempted",
                    "model_id",
                    "model_revision",
                    "permission_rules_json")),
            Map.entry("ma_session_head", Set.of(
                    "activation_epoch",
                    "claim_generation",
                    "committed_sequence",
                    "head_kind",
                    "is_wake_pending",
                    "journal_revision",
                    "storage_version",
                    "writer_generation")),
            Map.entry("ma_session_journal_tx", Set.of(
                    "activation_lease_until",
                    "activation_renewal_seq")),
            Map.entry("ma_event_stream", Set.of(
                    "covered_sequence",
                    "last_sequence",
                    "replay_floor_sequence",
                    "stream_kind",
                    "wake_covered_sequence")),
            Map.entry("ma_public_event", Set.of(
                    "data_json",
                    "is_archived",
                    "is_terminal",
                    "is_truncated",
                    "stream_kind")),
            Map.entry("ma_message", Set.of(
                    "revision")),
            Map.entry("ma_session_record", Set.of(
                    "action_id",
                    "action_version",
                    "options_json",
                    "record_kind",
                    "record_resource_id",
                    "workspace_id")),
            Map.entry("ma_resource", Set.of(
                    "byte_length",
                    "capture_state",
                    "publication_id",
                    "scope_key",
                    "slot_key")),
            Map.entry("ma_resource_ref", Set.of(
                    "owner_kind",
                    "owner_revision",
                    "runtime_binding_key")),
            Map.entry("ma_output_capture", Set.of(
                    "is_accepted_complete",
                    "is_quarantined",
                    "is_write_evidence")),
            Map.entry("ma_request_receipt", Set.of(
                    "is_workspace_bound",
                    "namespace",
                    "scope_kind")),
            Map.entry("ma_operation", Set.of(
                    "attempt_count",
                    "claim_generation",
                    "execution_mode",
                    "is_verification_ready",
                    "operation_kind",
                    "payload_version")),
            Map.entry("ma_operation_work", Set.of(
                    "work_kind")),
            Map.entry("ma_workspace", Set.of(
                    "is_default",
                    "state",
                    "workspace_generation",
                    "workspace_kind")),
            Map.entry("ma_workspace_access", Set.of(
                    "role")),
            Map.entry("ma_extension_package", Set.of(
                    "byte_length",
                    "package_revision",
                    "state")),
            Map.entry("ma_extension_settings", Set.of(
                    "settings_revision")),
            Map.entry("ma_extension_operation", Set.of(
                    "operation_kind",
                    "revision",
                    "state")),
            Map.entry("ma_storage", Set.of(
                    "physical_key",
                    "registration_json",
                    "registration_revision",
                    "registration_state")),
            Map.entry("ma_runtime_binding", Set.of(
                    "is_drain_requested")),
            Map.entry("ma_runtime_session", Set.of(
                    "is_execution_exclusive")),
            Map.entry("ma_tool_execution", Set.of(
                    "is_cancel_requested")),
            Map.entry("ma_tenant_guard", Set.of(
                    "guard_domain")),
            Map.entry("ma_read_lease", Set.of(
                    "retirement_generation")),
            Map.entry("ma_delivery", Set.of(
                    "attempt_count",
                    "claim_generation",
                    "claimed_at",
                    "delivery_kind",
                    "source_session_id")),
            Map.entry("ma_schedule", Set.of(
                    "is_enabled")),
            Map.entry("ma_session_worktree", Set.of(
                    "revision",
                    "state")),
            Map.entry("ma_session_principal", Set.of(
                    "is_actor_present")));

    private ManagedSchemaIntegrity() {}

    public static void validate(String table, Map<String, ?> row) {
        Objects.requireNonNull(row, "row");
        if (!ManagedSchemaContract.TABLES.contains(table)) {
            throw new IllegalArgumentException("Unknown Managed table: " + table);
        }
        if (!row.keySet().containsAll(FIELDS.getOrDefault(table, Set.of()))) {
            throw new IllegalArgumentException("Incomplete integrity candidate for " + table);
        }
        for (Rule rule : RULES.getOrDefault(table, List.of())) {
            // 与 SQL CHECK 相同：FALSE 拒绝，UNKNOWN 由保留的非空约束继续处理。
            if (Boolean.FALSE.equals(rule.predicate().apply(row))) {
                throw new IllegalArgumentException("Managed row violates " + rule.name());
            }
        }
    }

    public static Map<String, Object> row(Object... columns) {
        if ((columns.length & 1) != 0) {
            throw new IllegalArgumentException("Column names and values must be paired");
        }
        Map<String, Object> row = new LinkedHashMap<>();
        for (int index = 0; index < columns.length; index += 2) {
            String name = (String) columns[index];
            if (row.containsKey(name)) {
                throw new IllegalArgumentException("Duplicate integrity column: " + name);
            }
            row.put(name, columns[index + 1]);
        }
        return row;
    }

    private static Boolean and(Boolean... values) {
        boolean unknown = false;
        for (Boolean value : values) {
            if (Boolean.FALSE.equals(value)) {
                return false;
            }
            unknown |= value == null;
        }
        return unknown ? null : true;
    }

    private static Boolean or(Boolean... values) {
        boolean unknown = false;
        for (Boolean value : values) {
            if (Boolean.TRUE.equals(value)) {
                return true;
            }
            unknown |= value == null;
        }
        return unknown ? null : false;
    }

    private static Set<String> enumNames(Enum<?>[] values) {
        Set<String> names = new HashSet<>();
        for (Enum<?> value : values) {
            names.add(value.name());
        }
        return Set.copyOf(names);
    }

    private static Boolean domain(Object value, Set<String> values) {
        return value == null ? null : value instanceof String text && values.contains(text);
    }

    private static Boolean booleanValue(Object value) {
        return Boolean.TRUE.equals(eq(value, 0L)) || Boolean.TRUE.equals(eq(value, 1L));
    }

    private static Boolean absent(Object value) {
        return value == null;
    }

    private static Boolean present(Object value) {
        return value != null;
    }

    private static Boolean eq(Object left, Object right) {
        if (left == null || right == null) {
            return null;
        }
        if (numeric(left) || numeric(right)) {
            return decimal(left).compareTo(decimal(right)) == 0;
        }
        return left.equals(right);
    }

    private static Boolean ne(Object left, Object right) {
        Boolean equal = eq(left, right);
        return equal == null ? null : !equal;
    }

    private static Boolean gt(Object left, Object right) {
        return left == null || right == null ? null : decimal(left).compareTo(decimal(right)) > 0;
    }

    private static Boolean ge(Object left, Object right) {
        return left == null || right == null ? null : decimal(left).compareTo(decimal(right)) >= 0;
    }

    private static Boolean le(Object left, Object right) {
        return left == null || right == null ? null : decimal(left).compareTo(decimal(right)) <= 0;
    }

    private static boolean numeric(Object value) {
        return value instanceof Number || value instanceof Boolean;
    }

    private static BigDecimal decimal(Object value) {
        if (value instanceof Boolean bool) {
            return bool ? BigDecimal.ONE : BigDecimal.ZERO;
        }
        if (value instanceof Number number) {
            return new BigDecimal(number.toString());
        }
        throw new IllegalArgumentException("Integrity counter must be numeric");
    }

    private static Object octets(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes) {
            return bytes.length;
        }
        if (value instanceof String text) {
            return text.getBytes(StandardCharsets.UTF_8).length;
        }
        throw new IllegalArgumentException("Integrity text has an invalid type");
    }
}
