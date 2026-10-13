package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Calendar;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TimeZone;
import java.util.TreeSet;

/** Bounded current rows; caller fences and the native terminal proof remain required. */
final class WorkspaceCsiApplicationInventory {
    static final int MAX_ROWS = 4096;
    static final int MAX_BYTES = 32 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final List<Declaration> CATALOGUE = List.of(
            declaration("managed_agent_action", "tenant_id,session_id,action_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,action_id:VARCHAR,state:VARCHAR,options_json:LONGTEXT,"
                    + "decision_receipt_id:VARCHAR,decision_digest:VARCHAR,created_at:BIGINT"),
            declaration("managed_agent_artifact", "artifact_id",
                    "artifact_id:VARCHAR,result_id:VARCHAR,scope_key:CHAR,descriptor_json:MEDIUMTEXT,"
                    + "publication_id:VARCHAR,binding_json:MEDIUMTEXT,manifest_ref_json:MEDIUMTEXT,stream_id:VARCHAR,"
                    + "creation_sequence:BIGINT"),
            declaration("managed_agent_command", "tenant_id,operation,idempotency_key",
                    "tenant_id:VARCHAR,operation:VARCHAR,idempotency_key:VARCHAR,request_digest:VARCHAR,"
                    + "session_id:VARCHAR,turn_id:VARCHAR,created_at:BIGINT,command_status:VARCHAR,updated_at:BIGINT,"
                    + "session_status_before:VARCHAR,mutation_attempt_sequence:BIGINT"),
            declaration("managed_agent_consumer_progress", "tenant_id,session_id,consumer_name",
                    "tenant_id:VARCHAR,session_id:VARCHAR,consumer_name:VARCHAR,covered_sequence:BIGINT,updated_at:BIGINT,"
                    + "snapshot_stale_since:BIGINT"),
            declaration("managed_agent_definition", "tenant_id,agent_id,revision",
                    "tenant_id:VARCHAR,agent_id:VARCHAR,revision:BIGINT,digest:VARCHAR,definition_json:LONGTEXT,"
                    + "created_at:BIGINT"),
            declaration("managed_agent_definition_command", "tenant_id,idempotency_key",
                    "tenant_id:VARCHAR,idempotency_key:VARCHAR,request_digest:VARCHAR,agent_id:VARCHAR,revision:BIGINT,"
                    + "created_at:BIGINT"),
            declaration("managed_agent_event", "tenant_id,session_id,sequence_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,sequence_id:BIGINT,event_id:VARCHAR,turn_id:VARCHAR,"
                    + "event_type:VARCHAR,data_json:LONGTEXT,terminal:BOOLEAN,source_key:VARCHAR,created_at:BIGINT,"
                    + "schema_version:INT,projection_version:INT,item_id:VARCHAR,content_part_id:VARCHAR"),
            declaration("managed_agent_item", "tenant_id,session_id,item_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,item_id:VARCHAR,turn_id:VARCHAR,item_type:VARCHAR,"
                    + "item_role:VARCHAR,item_status:VARCHAR,attributes_json:LONGTEXT,first_sequence:BIGINT,"
                    + "last_sequence:BIGINT,created_at:BIGINT,updated_at:BIGINT,revision:BIGINT"),
            declaration("managed_agent_item_part", "tenant_id,session_id,item_id,part_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,item_id:VARCHAR,part_id:VARCHAR,part_type:VARCHAR,"
                    + "part_text:LONGTEXT,first_sequence:BIGINT,last_sequence:BIGINT,created_at:BIGINT,updated_at:BIGINT,"
                    + "revision:BIGINT"),
            declaration("managed_agent_operation", "tenant_id,session_id,operation_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,operation_id:VARCHAR,operation_kind:VARCHAR,"
                    + "actor_digest:VARCHAR,idempotency_key:VARCHAR,request_digest:VARCHAR,state:VARCHAR,"
                    + "admission_stage:VARCHAR,delivery_state:VARCHAR,session_status_before:VARCHAR,receipt_id:VARCHAR,"
                    + "lease_owner:VARCHAR,lease_until:BIGINT,claim_generation:BIGINT,attempt_count:INT,available_at:BIGINT,"
                    + "created_at:BIGINT,updated_at:BIGINT,completed_at:BIGINT,action_id:VARCHAR,response_json:LONGTEXT,"
                    + "error_code:VARCHAR,decision_receipt_id:VARCHAR,target_cwd_relative:VARCHAR,"
                    + "expected_context_revision:BIGINT,result_context_revision:BIGINT,lifecycle_protocol_version:INT,"
                    + "lifecycle_effects_receipt_json:LONGTEXT,actor_key:VARBINARY,task_id:VARCHAR"),
            declaration("managed_agent_session", "tenant_id,session_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,agent_id:VARCHAR,title:VARCHAR,status:VARCHAR,"
                    + "harness_boot_id:VARCHAR,harness_event_epoch:VARCHAR,harness_last_event_id:BIGINT,"
                    + "last_sequence:BIGINT,created_at:BIGINT,updated_at:BIGINT,version:BIGINT,deleted_at:BIGINT,"
                    + "workspace_id:VARCHAR,workspace_generation:BIGINT,workspace_storage_id:VARCHAR,cwd_relative:VARCHAR,"
                    + "context_config_ref:VARCHAR,context_revision:BIGINT,workspace_config_ref:VARCHAR,"
                    + "workspace_policy_ref:VARCHAR,agent_revision:VARCHAR,replay_floor_sequence:BIGINT,"
                    + "approval_mode:VARCHAR,tool_profile:VARCHAR,creator_actor_key:VARBINARY,owner_actor_key:VARBINARY,"
                    + "parent_session_id:VARCHAR,root_session_id:VARCHAR,parent_child_run_id:VARCHAR,child_depth:INT,"
                    + "runtime_request_key:VARCHAR,agent_definition_digest:VARCHAR,csi_guard:BOOLEAN"),
            declaration("managed_agent_snapshot", "tenant_id,session_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,snapshot_version:BIGINT,covered_sequence:BIGINT,"
                    + "items_json:LONGTEXT,created_at:BIGINT,updated_at:BIGINT"),
            declaration("managed_agent_tool_result", "result_id",
                    "result_id:VARCHAR,scope_key:CHAR,execution_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,"
                    + "session_id:VARCHAR,source_json:MEDIUMTEXT,source_digest:CHAR,work_state:VARCHAR,"
                    + "claim_generation:BIGINT,claim_until:BIGINT,next_attempt_at:BIGINT,attempts:INT,failure_code:VARCHAR,"
                    + "item_id:VARCHAR,descriptor_json:MEDIUMTEXT,policy_version:VARCHAR"),
            declaration("managed_agent_turn", "tenant_id,session_id,turn_id",
                    "tenant_id:VARCHAR,session_id:VARCHAR,turn_id:VARCHAR,prompt_id:VARCHAR,input_json:LONGTEXT,"
                    + "payload_digest:VARCHAR,status:VARCHAR,submission_attempted:BOOLEAN,harness_event_epoch:VARCHAR,"
                    + "harness_last_event_id:BIGINT,dispatch_owner:VARCHAR,dispatch_lease_until:BIGINT,error_code:VARCHAR,"
                    + "error_message:VARCHAR,created_at:BIGINT,updated_at:BIGINT,completed_at:BIGINT,version:BIGINT,"
                    + "retry_count:INT,retry_after:BIGINT"),
            declaration("managed_session_create_scope", "tenant_id,idempotency_key",
                    "tenant_id:VARCHAR,idempotency_key:VARCHAR,workspace_bound:BOOLEAN"),
            declaration("managed_workspace_access", "tenant_id,workspace_id,actor_id",
                    "tenant_id:VARCHAR,workspace_id:VARCHAR,actor_id:VARBINARY,role:VARCHAR"),
            declaration("managed_workspace_create_command", "tenant_id,actor_id,idempotency_key",
                    "tenant_id:VARCHAR,actor_id:VARBINARY,idempotency_key:VARCHAR,request_digest:VARCHAR,"
                    + "session_id:VARCHAR,turn_id:VARCHAR,created_at:BIGINT"),
            declaration("managed_workspace_csi_registration", "alias_key",
                    "alias_key:CHAR,tenant_id:VARCHAR,storage_id:VARCHAR,physical_key:CHAR,registration_revision:BIGINT,"
                    + "registration_json:LONGTEXT"),
            declaration("managed_workspace_csi_retirement", "retirement_id",
                    "retirement_id:CHAR,binding_id:VARCHAR,runtime_generation:BIGINT,physical_key:CHAR,phase:VARCHAR,"
                    + "identity_json:LONGTEXT,progress_format:VARCHAR,progress_version:BIGINT,progress_stage:VARCHAR,"
                    + "settlement_deadline_ms:BIGINT,frozen_request_bytes:LONGBLOB,frozen_request_sha256:CHAR,"
                    + "cut_bytes:LONGBLOB,cut_sha256:CHAR,finalize_receipt_bytes:LONGBLOB,finalize_receipt_sha256:CHAR"),
            declaration("managed_workspace_csi_source", "binding_id",
                    "binding_id:VARCHAR,runtime_generation:BIGINT,physical_key:CHAR,reservation_id:CHAR,reservation_revision:BIGINT,"
                    + "configuration_json:LONGTEXT,phase:VARCHAR,record_version:BIGINT,arm_bytes:LONGBLOB,arm_sequence:BIGINT,arm_hash:CHAR,"
                    + "pod_uid:CHAR,gated_spec_sha256:CHAR,bound_bytes:LONGBLOB,bound_sequence:BIGINT,bound_hash:CHAR,"
                    + "publication_bytes:LONGBLOB,publication_sequence:BIGINT,publication_hash:CHAR"),
            declaration("managed_workspace_csi_worker_ack", "retirement_id,execution_call_id_hash",
                    "retirement_id:CHAR,execution_call_id_hash:CHAR,execution_call_id:VARCHAR,evidence_json:LONGTEXT,"
                    + "evidence_digest:CHAR,recorded_at_epoch_micros:BIGINT"),
            declaration("managed_workspace_default", "tenant_id",
                    "tenant_id:VARCHAR,workspace_id:VARCHAR"),
            declaration("managed_workspace_execution_lease", "storage_key",
                    "storage_key:CHAR,holder_key:CHAR,binding_id:VARCHAR,runtime_generation:BIGINT,"
                    + "runtime_session_id:VARCHAR,tenant_id:VARCHAR,storage_id:VARCHAR,mount_revision:BIGINT,"
                    + "mount_state:VARCHAR,mount_operation_id:CHAR,mount_completed_operation_id:CHAR,mount_root:VARCHAR,"
                    + "mount_host_id:VARCHAR,mount_device:VARCHAR,mount_inode:VARCHAR,mount_birth_time:VARCHAR,"
                    + "mount_registration_id:CHAR,storage_kind:VARCHAR,csi_phase:VARCHAR,csi_revision:BIGINT,"
                    + "csi_reservation_id:CHAR,csi_registration_key:CHAR,csi_registration_revision:BIGINT,"
                    + "csi_provision_request_id:VARCHAR,maintenance_id:CHAR"),
            declaration("managed_workspace_migration", "operation_id",
                    "operation_id:VARCHAR,tenant_id:VARCHAR,storage_id:VARCHAR,request_digest:VARCHAR,"
                    + "request_json:LONGTEXT,state:VARCHAR,source_registration_json:LONGTEXT,target_identity_json:LONGTEXT,"
                    + "history_identity_json:LONGTEXT,target_registration_id:VARCHAR,verify_operation_id:VARCHAR,"
                    + "last_error_code:VARCHAR,result_json:LONGTEXT,updated_at:TIMESTAMP"),
            declaration("managed_workspace_operator_recovery", "recovery_id",
                    "recovery_id:CHAR,binding_id:VARCHAR,runtime_generation:BIGINT,storage_key:CHAR,holder_key:CHAR,"
                    + "runtime_session_id:VARCHAR,provision_request_id:VARCHAR,resource_handle_json:LONGTEXT,"
                    + "runtime_lease_id:VARCHAR,runtime_epoch:BIGINT,blocked_execution_call_id:VARCHAR,operator_id:VARCHAR,"
                    + "reason:VARCHAR,prepared_at:DATETIME,attestation_json:LONGTEXT,attestation_sha256:CHAR,"
                    + "attested_at:DATETIME,completed_at:DATETIME"),
            declaration("managed_workspace_recovery_operation", "operation_id",
                    "operation_id:CHAR,tenant_id:VARCHAR,storage_id:VARCHAR,mode:VARCHAR,capture_operation_id:CHAR,"
                    + "request_digest:CHAR,request_json:MEDIUMTEXT,registration_json:MEDIUMTEXT,source_digest:CHAR,"
                    + "session_count:BIGINT,state:VARCHAR,manifest_digest:CHAR,last_error_code:VARCHAR,"
                    + "result_json:MEDIUMTEXT,created_at:DATETIME,updated_at:DATETIME"),
            declaration("managed_workspace_recovery_session", "operation_id,session_id",
                    "operation_id:CHAR,session_id:VARCHAR,source_digest:CHAR,source_json:MEDIUMTEXT,state:VARCHAR,"
                    + "summary_json:MEDIUMTEXT"),
            declaration("managed_workspace_recovery_work", "operation_id,work_kind,key_hash",
                    "operation_id:CHAR,work_kind:VARCHAR,key_hash:CHAR,work_key:VARCHAR,session_id:VARCHAR,"
                    + "metadata_json:MEDIUMTEXT,state:VARCHAR"),
            declaration("managed_workspace_registry", "tenant_id,workspace_id",
                    "tenant_id:VARCHAR,workspace_id:VARCHAR,workspace_generation:BIGINT,storage_id:VARCHAR,"
                    + "display_name:VARCHAR,config_ref:VARCHAR,policy_ref:VARCHAR,state:VARCHAR"),
            declaration("qwen_csi_resource_read", "read_id",
                    "read_id:VARCHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,request_key:CHAR,"
                    + "binding_id:VARCHAR,runtime_generation:BIGINT,binding_version:BIGINT,writer_id:VARCHAR,"
                    + "writer_generation:BIGINT,writer_token_hash:CHAR,journal_revision:BIGINT,activation_id:VARCHAR,"
                    + "activation_epoch:BIGINT,resource_id:VARCHAR,kind:VARCHAR,schema_version:INT,byte_length:BIGINT,"
                    + "sha256:CHAR,storage_kind:VARCHAR,resource_state:VARCHAR,state:VARCHAR,started_at:BIGINT,"
                    + "delivery_expires_at:BIGINT,ended_at:BIGINT,outcome_code:VARCHAR"),
            declaration("qwen_managed_automation_command", "tenant_id,idempotency_key",
                    "tenant_id:VARCHAR,idempotency_key:VARCHAR,actor_id:VARCHAR,request_digest:VARCHAR,"
                    + "schedule_id:VARCHAR,result_json:LONGTEXT,created_at:BIGINT"),
            declaration("qwen_managed_automation_occurrence", "tenant_id,schedule_id,occurrence_key",
                    "tenant_id:VARCHAR,schedule_id:VARCHAR,occurrence_key:VARCHAR,run_id:VARCHAR,session_id:VARCHAR,"
                    + "slot:BIGINT,trigger_kind:VARCHAR,outcome:VARCHAR,reason:VARCHAR,definition_revision:BIGINT,"
                    + "fence:BIGINT,attempts:INT,next_retry_at:BIGINT,last_error:VARCHAR,created_at:BIGINT,"
                    + "updated_at:BIGINT"),
            declaration("qwen_managed_automation_schedule", "tenant_id,schedule_id",
                    "tenant_id:VARCHAR,schedule_id:VARCHAR,session_id:VARCHAR,workspace_id:VARCHAR,actor_id:VARCHAR,"
                    + "record_revision:BIGINT,definition_revision:BIGINT,definition_digest:CHAR,goal:VARCHAR,cron:VARCHAR,"
                    + "timezone:VARCHAR,session_mode:VARCHAR,overlap:VARCHAR,catch_up:VARCHAR,catch_up_limit:BIGINT,"
                    + "enabled:BOOLEAN,state:VARCHAR,blocked_reason:VARCHAR,armed_at:BIGINT,watermark_slot:BIGINT,"
                    + "lease_owner:VARCHAR,lease_until:BIGINT,fence:BIGINT,created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_channel_binding", "tenant_id,channel_id,route_id",
                    "tenant_id:VARCHAR,channel_id:VARCHAR,route_id:VARCHAR,session_id:VARCHAR,scope_kind:VARCHAR,"
                    + "sender_id:VARCHAR,chat_id:VARCHAR,thread_id:VARCHAR,created_at:BIGINT"),
            declaration("qwen_managed_channel_claim", "tenant_id,channel_id,delivery_id",
                    "tenant_id:VARCHAR,channel_id:VARCHAR,delivery_id:VARCHAR,session_id:VARCHAR,claimed_at:BIGINT"),
            declaration("qwen_managed_channel_delivery", "tenant_id,channel_instance_id,delivery_id",
                    "tenant_id:VARCHAR,channel_instance_id:VARCHAR,delivery_id:VARCHAR,segment_id:VARCHAR,"
                    + "segment_ordinal:INT,state:VARCHAR,provider_receipt:VARCHAR,created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_channel_instance", "tenant_id,channel_id",
                    "tenant_id:VARCHAR,channel_id:VARCHAR,platform:VARCHAR,account_id:VARCHAR,account_generation:BIGINT,"
                    + "state:VARCHAR,actor_id:VARCHAR,workspace_id:VARCHAR,cwd_relative:VARCHAR,policy_json:LONGTEXT,"
                    + "created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_channel_route", "tenant_id,route_key",
                    "tenant_id:VARCHAR,route_key:CHAR,channel_instance_id:VARCHAR,account_generation:BIGINT,"
                    + "platform_event_id:VARCHAR,semantic_revision:BIGINT,session_id:VARCHAR,sender_id:VARCHAR,"
                    + "chat_id:VARCHAR,thread_id:VARCHAR,state:VARCHAR,input_id:VARCHAR,"
                    + "staged_attachment_refs_json:LONGTEXT,created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_child_result_relay", "parent_session_id,child_run_id",
                    "tenant_id:VARCHAR,parent_session_id:VARCHAR,child_run_id:VARCHAR,creation_key:VARCHAR,"
                    + "child_session_id:VARCHAR,state:VARCHAR,claimed_by:VARCHAR,claimed_until:BIGINT,attempts:INT,"
                    + "next_retry_at:BIGINT,last_error:VARCHAR,created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_child_workspace", "parent_session_id,child_run_id",
                    "tenant_id:VARCHAR,parent_session_id:VARCHAR,child_run_id:VARCHAR,child_workspace_id:CHAR,"
                    + "workspace_id:VARCHAR,workspace_generation:BIGINT,storage_id:VARCHAR,parent_cwd_relative:VARCHAR,"
                    + "repository_relative:VARCHAR,child_cwd_relative:VARCHAR,base_commit:VARCHAR,result_commit:VARCHAR,"
                    + "parent_tree:VARCHAR,merged_tree:VARCHAR,state:VARCHAR,finish_request:VARCHAR,outcome_code:VARCHAR,"
                    + "conflict_paths:LONGTEXT,last_error:VARCHAR,claimed_by:VARCHAR,claimed_until:BIGINT,"
                    + "claim_generation:BIGINT,attempts:INT,next_retry_at:BIGINT,created_at:BIGINT,updated_at:BIGINT"),
            declaration("qwen_managed_session_extension_record", "session_scope_key,record_key",
                    "session_scope_key:CHAR,record_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,"
                    + "domain:VARCHAR,record_id:VARCHAR,operation_hash:CHAR,revision:BIGINT,record_resource_id:VARCHAR,"
                    + "task_kind:VARCHAR,task_state:VARCHAR,runtime_state:VARCHAR,definition_revision:BIGINT,"
                    + "delivery_target:VARCHAR,delivery_state:VARCHAR,created_at:BIGINT,started_at:BIGINT,settled_at:BIGINT,"
                    + "first_sequence:BIGINT,hook_once_key_hash:CHAR,hook_occurrence_hash:CHAR,hook_ordinal:BIGINT,"
                    + "hook_definition_hash:CHAR"),
            declaration("qwen_managed_session_journal_head", "tenant_id,session_id",
                    "tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,storage_version:INT,state:VARCHAR,"
                    + "writer_generation:BIGINT,writer_id:VARCHAR,writer_lease_until:DATETIME,lease_token_hash:CHAR,"
                    + "journal_revision:BIGINT,committed_sequence:BIGINT,last_commit_digest:CHAR,activation_epoch:BIGINT,"
                    + "latest_checkpoint_resource_id:VARCHAR,compacted_through_revision:BIGINT,recovery_status:VARCHAR,"
                    + "recovery_detail_code:VARCHAR,created_at:DATETIME,updated_at:DATETIME,o3_backfill_revision:BIGINT,"
                    + "o3_backfill_through:BIGINT,o3_backfill_error:VARCHAR,o3_backfill_pending:BOOLEAN,"
                    + "activation_id:VARCHAR,activation_phase:VARCHAR,activation_event_epoch:BIGINT,"
                    + "activation_expires_at:BIGINT,activation_head_revision:BIGINT"),
            declaration("qwen_managed_session_journal_tx", "tenant_id,session_id,journal_revision",
                    "tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,journal_revision:BIGINT,"
                    + "command_key_hash:CHAR,transaction_id:VARCHAR,operation:LONGTEXT,command_id:VARCHAR,"
                    + "content_digest:CHAR,first_sequence:BIGINT,last_sequence:BIGINT,event_count:INT,events_digest:CHAR,"
                    + "previous_commit_digest:CHAR,commit_digest:CHAR,writer_generation:BIGINT,writer_id:VARCHAR,"
                    + "writer_token_hash:CHAR,activation_epoch:BIGINT,latest_checkpoint_resource_id:VARCHAR,"
                    + "record_encoding:VARCHAR,record_bytes:MEDIUMBLOB,byte_length:BIGINT,record_digest:CHAR,"
                    + "created_at:DATETIME"),
            declaration("qwen_managed_session_resource", "session_scope_key,resource_id",
                    "session_scope_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,resource_id:VARCHAR,"
                    + "kind:VARCHAR,schema_version:INT,byte_length:BIGINT,sha256:CHAR,storage_kind:VARCHAR,"
                    + "inline_bytes:MEDIUMBLOB,object_key:VARCHAR,object_version_id:VARCHAR,encryption_key_id:VARCHAR,"
                    + "publish_command_id:VARCHAR,state:VARCHAR,created_at:DATETIME,last_verified_at:DATETIME,"
                    + "retention_until:DATETIME"),
            declaration("qwen_managed_session_resource_ref", "session_scope_key,journal_revision,resource_id",
                    "session_scope_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,"
                    + "journal_revision:BIGINT,resource_id:VARCHAR,created_at:DATETIME"),
            declaration("qwen_managed_session_task_journal", "session_scope_key,task_id,event_sequence",
                    "session_scope_key:CHAR,tenant_id:VARCHAR,session_id:VARCHAR,task_id:VARCHAR,event_sequence:BIGINT,"
                    + "event_type:VARCHAR,occurred_at:BIGINT,schema_version:INT,projection_version:INT,state:VARCHAR,"
                    + "runtime_state:VARCHAR,text:MEDIUMTEXT,truncated:BOOLEAN,artifact_id:VARCHAR,capture_id:VARCHAR,"
                    + "stream_id:VARCHAR,first_ordinal:BIGINT,end_ordinal:BIGINT,archived:BOOLEAN"),
            declaration("qwen_managed_session_task_journal_cursor", "session_scope_key,task_id",
                    "session_scope_key:CHAR,tenant_id:VARCHAR,session_id:VARCHAR,task_id:VARCHAR,last_sequence:BIGINT,"
                    + "expired_through:BIGINT,artifact_refs:MEDIUMTEXT"),
            declaration("qwen_output_put_attempt", "attempt_id",
                    "attempt_id:VARCHAR,scope_key:CHAR,publication_id:VARCHAR,object_key:VARCHAR,state:VARCHAR,"
                    + "started_at:BIGINT,completed_at:BIGINT"),
            declaration("qwen_output_read_lease", "lease_id",
                    "lease_id:VARCHAR,tenant_key:CHAR,session_key:CHAR,retirement_generation:BIGINT,expires_at:BIGINT"),
            declaration("qwen_output_session_retirement", "tenant_key,session_key",
                    "tenant_key:CHAR,session_key:CHAR,tenant_id:VARCHAR,session_id:VARCHAR,operation_id:VARCHAR,"
                    + "generation:BIGINT,retired_at:BIGINT,recovery_protected:BOOLEAN"),
            declaration("qwen_runtime_binding", "binding_id",
                    "binding_id:VARCHAR,request_key:CHAR,scope_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,"
                    + "workspace_generation:VARCHAR,canonical_cwd:VARCHAR,capability_digest:VARCHAR,isolation_class:VARCHAR,"
                    + "isolation_key:VARCHAR,provisioner_kind:VARCHAR,runtime_generation:BIGINT,binding_state:VARCHAR,"
                    + "provision_request_id:VARCHAR,provision_seed_ciphertext:LONGTEXT,credential_key_id:VARCHAR,"
                    + "resource_handle_version:INT,resource_handle_json:LONGTEXT,runtime_instance_id:VARCHAR,"
                    + "runtime_endpoint:VARCHAR,runtime_lease_id:VARCHAR,runtime_epoch:BIGINT,"
                    + "runtime_credential_ciphertext:LONGTEXT,runtime_credential_key_id:VARCHAR,"
                    + "attestation_generation:BIGINT,drain_requested:BOOLEAN,operation_owner:VARCHAR,"
                    + "operation_lease_until:DATETIME,operation_generation:BIGINT,record_version:BIGINT,"
                    + "last_health_at:DATETIME,last_reconciled_at:DATETIME,last_active_at:DATETIME,storage_id:VARCHAR,"
                    + "loss_evidence_json:LONGTEXT,stop_evidence_json:LONGTEXT,drain_receipt_json:LONGTEXT,"
                    + "first_activation_journal_revision:BIGINT"),
            declaration("qwen_runtime_binding_slot", "request_key",
                    "request_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,workspace_generation:VARCHAR,"
                    + "canonical_cwd:VARCHAR,capability_digest:VARCHAR,isolation_class:VARCHAR,isolation_key:VARCHAR,"
                    + "provisioner_kind:VARCHAR,last_generation:BIGINT,active_binding_id:VARCHAR,storage_id:VARCHAR"),
            declaration("qwen_runtime_harness_drain", "tenant_key,harness_key",
                    "tenant_key:VARCHAR,harness_key:VARCHAR,tenant_id:VARCHAR,harness_session_id:VARCHAR,phase:VARCHAR,"
                    + "operation_id:VARCHAR,claim_generation:BIGINT,claim_lease_until:BIGINT"),
            declaration("qwen_runtime_placement_guard", "tenant_key",
                    "tenant_key:CHAR,tenant_id:VARCHAR"),
            declaration("qwen_runtime_session", "scope_key,runtime_session_id",
                    "runtime_session_id:VARCHAR,scope_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,"
                    + "workspace_generation:VARCHAR,canonical_cwd:VARCHAR,capability_digest:VARCHAR,isolation_class:VARCHAR,"
                    + "harness_session_id:VARCHAR,turn_kind:VARCHAR,binding_id:VARCHAR,runtime_generation:BIGINT,"
                    + "session_state:VARCHAR,record_version:BIGINT,last_active_at:DATETIME"),
            declaration("qwen_runtime_storage_fence", "tenant_key,storage_key",
                    "tenant_key:VARCHAR,storage_key:VARCHAR,tenant_id:VARCHAR,storage_id:VARCHAR,operation_id:VARCHAR"),
            declaration("qwen_tool_execution", "execution_call_id_hash",
                    "execution_call_id_hash:CHAR,execution_call_id:VARCHAR,idempotency_key_hash:CHAR,"
                    + "idempotency_key:VARCHAR,binding_id:VARCHAR,runtime_generation:BIGINT,harness_session_id:VARCHAR,"
                    + "runtime_session_id:VARCHAR,runtime_session_key:CHAR,turn_id:VARCHAR,tool_call_id:VARCHAR,"
                    + "request_digest:VARCHAR,reference_json:LONGTEXT,execution_state:VARCHAR,execution_status:VARCHAR,"
                    + "result_json:LONGTEXT,last_sequence:BIGINT,cancel_requested:BOOLEAN,dispatch_owner:VARCHAR,"
                    + "dispatch_lease_until:DATETIME,dispatch_generation:BIGINT,record_version:BIGINT,settled_at:DATETIME,"
                    + "abandoned_at:DATETIME,loss_evidence_id:VARCHAR,authorized_dispatch_generation:BIGINT,"
                    + "authorized_binding_version:BIGINT,native_authorization_json:LONGTEXT"),
            declaration("qwen_tool_publication", "scope_key,publication_id",
                    "scope_key:CHAR,tenant_key:CHAR,tenant_id:VARCHAR,workspace_id:VARCHAR,session_id:VARCHAR,"
                    + "publication_id:VARCHAR,execution_key:CHAR,capture_id:VARCHAR,binding_json:MEDIUMTEXT,"
                    + "binding_digest:CHAR,token_hash:CHAR,state:VARCHAR,expires_at:BIGINT,capture_bytes:BIGINT,"
                    + "producer_bytes:BIGINT,admission_bytes:BIGINT,producer_phase:VARCHAR,quarantined:BOOLEAN,"
                    + "active_operation_id:VARCHAR,finish_operation_id:VARCHAR,finish_predecessor_id:VARCHAR,"
                    + "finish_digest:CHAR,terminal_resource_id:VARCHAR,admission_resource_id:VARCHAR,"
                    + "receipt_sequence:BIGINT,receipt_revision:BIGINT,capture_held_bytes:BIGINT,producer_held_bytes:BIGINT,"
                    + "admission_held_bytes:BIGINT,capture_used_bytes:BIGINT,producer_used_bytes:BIGINT,"
                    + "admission_used_bytes:BIGINT,retention_state:VARCHAR,write_evidence:BOOLEAN,accepted_complete:BOOLEAN,"
                    + "gc_generation:BIGINT,gc_owner:VARCHAR,gc_claim_until:BIGINT,gc_cursor:VARCHAR,gc_next_at:BIGINT,"
                    + "gc_blocker:VARCHAR,collected_at:BIGINT,collected_bytes:BIGINT,released_held_bytes:BIGINT"),
            declaration("qwen_tool_publication_object", "scope_key,publication_id,slot_key",
                    "scope_key:CHAR,publication_id:VARCHAR,slot_key:VARCHAR,resource_id:VARCHAR,resource_kind:VARCHAR,"
                    + "byte_length:BIGINT,sha256:CHAR,object_key:VARCHAR,inline_bytes:MEDIUMBLOB,state:VARCHAR,"
                    + "operation_id:VARCHAR,created_at:DATETIME"),
            declaration("qwen_tool_publication_operation", "scope_key,publication_id,operation_id",
                    "scope_key:CHAR,publication_id:VARCHAR,operation_id:VARCHAR,request_digest:CHAR,slot_key:VARCHAR,"
                    + "state:VARCHAR,claim_owner:VARCHAR,claim_epoch:BIGINT,claim_until:DATETIME,deadline:DATETIME,"
                    + "receipt_json:MEDIUMTEXT,created_at:DATETIME,recovery_deadline:DATETIME,"
                    + "execution_mode:VARCHAR,verification_request_json:MEDIUMTEXT,verification_ready:BOOLEAN,"
                    + "verification_next_at:DATETIME,failure_status:INT,failure_code:VARCHAR"),
            declaration("qwen_tool_publication_seal", "scope_key,publication_id,stream_id",
                    "scope_key:CHAR,publication_id:VARCHAR,stream_id:VARCHAR,segment_count:INT,byte_length:BIGINT,"
                    + "sha256:CHAR,operation_id:VARCHAR"),
            declaration("qwen_tool_publication_tenant", "tenant_key",
                    "tenant_key:CHAR,tenant_id:VARCHAR")
    );

    enum Membership { ORIGINAL, CONTEXT, OTHER }

    enum Kind {
        VARCHAR, CHAR, LONGTEXT, MEDIUMTEXT, BIGINT, INT, TINYINT,
        BOOLEAN, VARBINARY, MEDIUMBLOB, LONGBLOB, DATETIME, TIMESTAMP;

        boolean accepts(int type) {
            return switch (this) {
                case VARCHAR -> type == Types.VARCHAR;
                case CHAR -> type == Types.CHAR;
                case LONGTEXT, MEDIUMTEXT -> type == Types.LONGVARCHAR || type == Types.CLOB || type == Types.VARCHAR;
                case BIGINT -> type == Types.BIGINT;
                case INT -> type == Types.INTEGER;
                case TINYINT -> type == Types.TINYINT;
                case BOOLEAN -> type == Types.BOOLEAN || type == Types.BIT || type == Types.TINYINT;
                case VARBINARY -> type == Types.VARBINARY;
                case MEDIUMBLOB, LONGBLOB -> type == Types.BLOB || type == Types.LONGVARBINARY || type == Types.VARBINARY;
                case DATETIME, TIMESTAMP -> type == Types.TIMESTAMP;
            };
        }

        boolean binary() {
            return this == VARBINARY || this == MEDIUMBLOB || this == LONGBLOB;
        }

        boolean integral() {
            return this == BIGINT || this == INT || this == TINYINT;
        }
    }

    record Column(String name, Kind kind) {
    }

    static final class Cell {
        private final Kind kind;
        private final byte[] bytes;

        private Cell(Kind kind, byte[] bytes) {
            this.kind = kind;
            this.bytes = bytes == null ? null : bytes.clone();
        }

        Kind kind() { return kind; }
        boolean isNull() { return bytes == null; }
        byte[] bytes() { return bytes == null ? null : bytes.clone(); }
        String text() {
            if (kind.binary()) {
                throw new IllegalStateException("Binary cell has no text representation");
            }
            return bytes == null ? null : new String(bytes, StandardCharsets.UTF_8);
        }
        Long number() { return bytes == null ? null : Long.valueOf(text()); }
        Boolean bool() {
            if (bytes == null) {
                return null;
            }
            return switch (text()) {
                case "true", "1" -> true;
                case "false", "0" -> false;
                default -> throw new IllegalStateException("Cell is not a boolean");
            };
        }

        @Override
        public boolean equals(Object value) {
            return value instanceof Cell other && kind == other.kind && Arrays.equals(bytes, other.bytes);
        }

        @Override
        public int hashCode() { return 31 * kind.hashCode() + Arrays.hashCode(bytes); }
    }

    static final class Row {
        private final List<Cell> key;
        private final Map<String, Cell> fields;
        private final byte[] bytes;
        private final Membership membership;

        private Row(List<Cell> key, Map<String, Cell> fields, byte[] bytes, Membership membership) {
            this.key = List.copyOf(key);
            this.fields = Collections.unmodifiableMap(new LinkedHashMap<>(fields));
            this.bytes = bytes.clone();
            this.membership = membership;
        }

        List<Cell> key() { return key; }
        Map<String, Cell> fields() { return fields; }
        byte[] bytes() { return bytes.clone(); }
        Membership membership() { return membership; }
        Cell cell(String name) { return fields.get(name); }
        String text(String name) {
            Cell value = cell(name);
            return value == null ? null : value.text();
        }
        Long number(String name) {
            Cell value = cell(name);
            return value == null ? null : value.number();
        }
        Boolean bool(String name) {
            Cell value = cell(name);
            return value == null ? null : value.bool();
        }
        byte[] binary(String name) {
            Cell value = cell(name);
            return value == null ? null : value.bytes();
        }

        private Row withMembership(Membership value) { return new Row(key, fields, bytes, value); }
    }

    record Table(String name, List<Column> columns, List<String> primaryKey, List<Row> rows) {
        Table {
            columns = List.copyOf(columns);
            primaryKey = List.copyOf(primaryKey);
            rows = List.copyOf(rows);
        }
    }

    record Blocker(String table, String key, String code) {
    }

    static final class Snapshot {
        private final List<Table> tables;
        private final List<Blocker> blockers;
        private final int rowCount;
        private final long byteCount;
        private final byte[] bytes;

        private Snapshot(List<Table> tables, List<Blocker> blockers, int rowCount, long byteCount) {
            this.tables = List.copyOf(tables);
            this.blockers = List.copyOf(blockers);
            this.rowCount = rowCount;
            this.byteCount = byteCount;
            this.bytes = encode(out -> {
                write(out, "qwen-csi-application-inventory/1");
                out.writeInt(tables.size());
                for (Table table : tables) {
                    write(out, table.name());
                    out.writeInt(table.columns().size());
                    for (Column column : table.columns()) {
                        write(out, column.name());
                        write(out, column.kind().name());
                    }
                    out.writeInt(table.primaryKey().size());
                    for (String key : table.primaryKey()) {
                        write(out, key);
                    }
                    out.writeInt(table.rows().size());
                    for (Row row : table.rows()) {
                        write(out, row.membership().name());
                        write(out, row.bytes);
                    }
                }
                out.writeInt(blockers.size());
                for (Blocker blocker : blockers) {
                    write(out, blocker.table());
                    write(out, blocker.key());
                    write(out, blocker.code());
                }
            });
        }

        List<Table> tables() { return tables; }
        List<Blocker> blockers() { return blockers; }
        int rowCount() { return rowCount; }
        long byteCount() { return byteCount; }
        byte[] bytes() { return bytes.clone(); }
        Table table(String name) {
            return tables.stream().filter(table -> table.name().equals(name)).findFirst().orElseThrow();
        }
    }

    static Snapshot inspect(Connection target, JdbcCsiFilesRetirementGuard.Original original,
            WorkspaceCsiReservationStore.Retirement intent) throws SQLException {
        if (target == null || target.getAutoCommit() || original == null || intent == null) {
            throw new IllegalArgumentException("An original transaction and validated original intent are required");
        }
        var inventory = new Inspection(target, original, intent);
        inventory.discover();
        inventory.validate();
        return inventory.snapshot();
    }

    static Snapshot restoreCanonical(byte[] bytes) {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid persisted CSI inventory");
        }
        try (var input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            requireEncoded("qwen-csi-application-inventory/1".equals(readText(input))
                    && input.readInt() == CATALOGUE.size());
            List<Table> tables = new ArrayList<>();
            int rows = 0;
            long rowBytes = 0;
            for (Declaration declaration : CATALOGUE) {
                requireEncoded(declaration.name().equals(readText(input))
                        && input.readInt() == declaration.columns().size());
                for (Column column : declaration.columns()) {
                    requireEncoded(column.name().equals(readText(input)) && column.kind().name().equals(readText(input)));
                }
                requireEncoded(input.readInt() == declaration.keys().size());
                for (String key : declaration.keys()) {
                    requireEncoded(key.equals(readText(input)));
                }
                int count = input.readInt();
                requireEncoded(count >= 0 && count <= MAX_ROWS - rows);
                List<Row> current = new ArrayList<>();
                Row previous = null;
                for (int index = 0; index < count; index++) {
                    Membership membership = Membership.valueOf(readText(input));
                    byte[] raw = readBytes(input, false);
                    rowBytes += raw.length;
                    requireEncoded(rowBytes <= MAX_BYTES);
                    Row row = restoreRow(declaration, raw, membership);
                    requireEncoded(previous == null || compareKeys(previous, row) < 0);
                    current.add(row);
                    previous = row;
                }
                rows += count;
                tables.add(new Table(declaration.name(), declaration.columns(), declaration.keys(), current));
            }
            requireEncoded(input.readInt() == 0 && input.available() == 0);
            Snapshot restored = new Snapshot(tables, List.of(), rows, rowBytes);
            requireEncoded(Arrays.equals(bytes, restored.bytes));
            return restored;
        } catch (IOException | RuntimeException malformed) {
            throw new IllegalArgumentException("Invalid persisted CSI inventory", malformed);
        }
    }

    static Row expectedRow(String table, Map<String, byte[]> values, Membership membership) {
        Declaration declaration = CATALOGUE.stream().filter(value -> value.name().equals(table)).findFirst().orElseThrow();
        requireEncoded(values.keySet().equals(declaration.columns().stream().map(Column::name).collect(java.util.stream.Collectors.toSet())));
        byte[] bytes = encode(out -> {
            out.writeInt(declaration.columns().size());
            for (Column column : declaration.columns()) {
                write(out, column.name());
                write(out, column.kind().name());
                write(out, values.get(column.name()));
            }
        });
        try {
            return restoreRow(declaration, bytes, membership);
        } catch (IOException malformed) {
            throw new IllegalArgumentException("Invalid expected CSI inventory row", malformed);
        }
    }

    static Snapshot expectedImage(List<Table> tables) {
        int rows = tables.stream().mapToInt(table -> table.rows().size()).sum();
        long bytes = tables.stream().flatMap(table -> table.rows().stream()).mapToLong(row -> row.bytes.length).sum();
        requireEncoded(rows <= MAX_ROWS && bytes <= MAX_BYTES);
        return restoreCanonical(new Snapshot(tables, List.of(), rows, bytes).bytes());
    }

    private static Row restoreRow(Declaration declaration, byte[] bytes, Membership membership) throws IOException {
        try (var input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            requireEncoded(input.readInt() == declaration.columns().size());
            Map<String, Cell> fields = new LinkedHashMap<>();
            for (Column column : declaration.columns()) {
                requireEncoded(column.name().equals(readText(input)) && column.kind().name().equals(readText(input)));
                byte[] value = readBytes(input, true);
                if (value != null && !column.kind().binary()) {
                    String text = strictText(value);
                    if (column.kind().integral()) {
                        long number = Long.parseLong(text);
                        requireEncoded(text.equals(Long.toString(number)));
                        if (column.kind() == Kind.INT) {
                            requireEncoded(number >= Integer.MIN_VALUE && number <= Integer.MAX_VALUE);
                        } else if (column.kind() == Kind.TINYINT) {
                            requireEncoded(number >= -128 && number <= 127);
                        }
                    } else if (column.kind() == Kind.BOOLEAN) {
                        requireEncoded(text.equals("true") || text.equals("false"));
                    } else if (column.kind() == Kind.DATETIME || column.kind() == Kind.TIMESTAMP) {
                        requireEncoded(Instant.parse(text).toString().equals(text));
                    }
                }
                fields.put(column.name(), new Cell(column.kind(), value));
            }
            requireEncoded(input.available() == 0);
            List<Cell> key = declaration.keys().stream().map(fields::get).toList();
            requireEncoded(key.stream().noneMatch(Cell::isNull));
            return new Row(key, fields, bytes, membership);
        }
    }

    private static byte[] readBytes(DataInputStream input, boolean nullable) throws IOException {
        int length = input.readInt();
        if (length == -1 && nullable) {
            return null;
        }
        requireEncoded(length >= 0 && length <= MAX_BYTES && length <= input.available());
        return input.readNBytes(length);
    }

    private static String readText(DataInputStream input) throws IOException {
        return strictText(readBytes(input, false));
    }

    private static String strictText(byte[] bytes) throws IOException {
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }

    private static void requireEncoded(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid persisted CSI inventory");
        }
    }

    private record Declaration(String name, List<String> keys, List<Column> columns) {
        private Declaration {
            keys = List.copyOf(keys);
            columns = List.copyOf(columns);
        }
    }

    private static Declaration declaration(String name, String keys, String columns) {
        return new Declaration(name, List.of(keys.split(",")),
                Arrays.stream(columns.split(",")).map(value -> {
                    String[] parts = value.split(":");
                    return new Column(parts[0], Kind.valueOf(parts[1]));
                }).toList());
    }

    private static final class Inspection {
        private final Connection connection;
        private final JdbcCsiFilesRetirementGuard.Original original;
        private final WorkspaceCsiReservationStore.Retirement intent;
        private final String tenant;
        private final String workspace;
        private final String session;
        private final String storage;
        private final Map<String, Set<String>> ids = new LinkedHashMap<>();
        private final Map<String, Map<String, Row>> tables = new LinkedHashMap<>();
        private final Set<Blocker> blockers = new LinkedHashSet<>();
        private final Set<String> failedTables = new LinkedHashSet<>();
        private int rowCount;
        private long byteCount;
        private boolean overflow;

        private Inspection(Connection connection, JdbcCsiFilesRetirementGuard.Original original,
                WorkspaceCsiReservationStore.Retirement intent) {
            this.connection = connection;
            this.original = original;
            this.intent = intent;
            var scope = original.request().getScope();
            tenant = scope.getTenantId();
            workspace = scope.getWorkspaceId();
            session = original.request().getIsolationKey();
            storage = original.request().getStorageId();
            id("T", tenant);
            id("W", workspace);
            id("D", storage);
            id("sessions", session);
            id("bindings", original.bindingId());
            id("requests", original.request().requestKey());
            id("retirements", intent.operationId());
            id("operations", intent.operationId());
            seed("runtime_session_id", session);
            seed("runtime_session_id", intent.runtimeInstanceId());
            id("A", intent.reservation().registrationKey());
            id("F", intent.physicalKey());
            id("J", hash((tenant + "\u0000" + session).getBytes(StandardCharsets.UTF_8)));
            id("M", digest(tenant, session));
            try {
                id("U", hash(JSON.writeValueAsBytes(List.of(tenant, workspace, session))));
            } catch (IOException exception) {
                throw new IllegalArgumentException("Original publication scope cannot be encoded", exception);
            }
            id("RT", hash(tenant.getBytes(StandardCharsets.UTF_8)));
            id("RS", hash(session.getBytes(StandardCharsets.UTF_8)));
            id("BT", JdbcRuntimeBindingRepository.harnessDrainKey(tenant));
            id("BS", JdbcRuntimeBindingRepository.harnessDrainKey(session));
            id("BD", JdbcRuntimeBindingRepository.harnessDrainKey(storage));
            id("L", hash((tenant + "\u0000" + storage).getBytes(StandardCharsets.UTF_8)));
            id("Bscope", digest(scope.getTenantId(), scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                    scope.getCanonicalCwd(), scope.getCapabilityDigest(), scope.getIsolationClass()));
            for (Declaration declaration : CATALOGUE) {
                tables.put(declaration.name(), new LinkedHashMap<>());
            }
        }

        private boolean id(String namespace, String value) {
            if (value == null || value.isEmpty()) {
                return false;
            }
            Set<String> values = ids.computeIfAbsent(namespace, ignored -> new TreeSet<>());
            boolean added = values.add(value);
            if (values.size() > MAX_ROWS) {
                overflow = true;
                block("inventory", namespace, "reference_limit");
            }
            return added;
        }

        private Set<String> values(String namespace) { return ids.getOrDefault(namespace, Set.of()); }

        private boolean has(String namespace, String value) {
            return value != null && values(namespace).contains(value);
        }

        private void discover() throws SQLException {
            boolean changed;
            do {
                changed = false;
                for (Declaration declaration : CATALOGUE) {
                    if (overflow) {
                        return;
                    }
                    if (!failedTables.contains(declaration.name())) {
                        int before = rowCount;
                        int size = ids.values().stream().mapToInt(Set::size).sum();
                        scan(declaration);
                        changed |= rowCount != before || size != ids.values().stream().mapToInt(Set::size).sum();
                    }
                }
            } while (changed);
        }

        private void scan(Declaration declaration) throws SQLException {
            Query query = predicate(declaration.name());
            String sql = "SELECT t.* FROM " + declaration.name() + " t WHERE (" + query.sql() + ") ORDER BY "
                    + String.join(",", declaration.keys()) + " LIMIT " + (MAX_ROWS + 1) + " FOR UPDATE";
            try (var statement = connection.prepareStatement(sql)) {
                statement.setQueryTimeout(10);
                for (int index = 0; index < query.arguments().size(); index++) {
                    statement.setString(index + 1, query.arguments().get(index));
                }
                try (var rows = statement.executeQuery()) {
                    if (!schema(rows.getMetaData(), declaration)) {
                        failedTables.add(declaration.name());
                        block(declaration.name(), null, "schema_drift");
                        return;
                    }
                    int fetched = 0;
                    while (rows.next()) {
                        if (++fetched > MAX_ROWS || overflow) {
                            overflow = true;
                            block(declaration.name(), null, "row_limit");
                            return;
                        }
                        Row row = read(rows, declaration);
                        if (row == null) {
                            return;
                        }
                        Membership membership = membership(declaration.name(), row);
                        if (membership == null) {
                            continue;
                        }
                        row = row.withMembership(membership);
                        String key = key(row);
                        Row previous = tables.get(declaration.name()).get(key);
                        if (previous != null) {
                            if (!Arrays.equals(previous.bytes, row.bytes)) {
                                block(declaration.name(), key, "same_key_conflicting_bytes");
                            } else if (previous.membership == Membership.OTHER && membership != Membership.OTHER) {
                                tables.get(declaration.name()).put(key, row);
                                if (membership == Membership.ORIGINAL) {
                                    expand(declaration.name(), row);
                                }
                            }
                            continue;
                        }
                        if (rowCount == MAX_ROWS || byteCount + row.bytes.length > MAX_BYTES) {
                            overflow = true;
                            block(declaration.name(), key, rowCount == MAX_ROWS ? "row_limit" : "byte_limit");
                            return;
                        }
                        tables.get(declaration.name()).put(key, row);
                        rowCount++;
                        byteCount += row.bytes.length;
                        if (membership == Membership.ORIGINAL) {
                            expand(declaration.name(), row);
                        }
                    }
                }
            } catch (SQLException exception) {
                failedTables.add(declaration.name());
                block(declaration.name(), null, "query_unavailable");
            }
        }

        private Row read(ResultSet result, Declaration declaration) throws SQLException {
            var fields = new LinkedHashMap<String, Cell>();
            long total = 0;
            try {
                for (int index = 0; index < declaration.columns().size(); index++) {
                    Column column = declaration.columns().get(index);
                    byte[] bytes;
                    if (column.kind().binary()) {
                        try (InputStream input = result.getBinaryStream(index + 1)) {
                            bytes = input == null ? null : input.readNBytes(MAX_BYTES + 1);
                        }
                    } else if (column.kind().integral()) {
                        long number = result.getLong(index + 1);
                        bytes = result.wasNull() ? null : utf8(Long.toString(number));
                    } else if (column.kind() == Kind.BOOLEAN) {
                        String value = result.getString(index + 1);
                        if (value != null && !Set.of("0", "1", "TRUE", "FALSE", "true", "false").contains(value)) {
                            block(declaration.name(), null, "invalid_boolean");
                            return null;
                        }
                        bytes = value == null ? null : utf8(value.equals("1") || value.equalsIgnoreCase("true") ? "true" : "false");
                    } else if (column.kind() == Kind.DATETIME || column.kind() == Kind.TIMESTAMP) {
                        var value = result.getTimestamp(index + 1, Calendar.getInstance(TimeZone.getTimeZone("UTC")));
                        bytes = value == null ? null : utf8(value.toInstant().toString());
                    } else {
                        try (Reader reader = result.getCharacterStream(index + 1)) {
                            if (reader == null) {
                                bytes = null;
                            } else {
                                var text = new StringBuilder();
                                char[] part = new char[4096];
                                int count;
                                while ((count = reader.read(part)) != -1) {
                                    if (text.length() + count > MAX_BYTES) {
                                        overflow = true;
                                        block(declaration.name(), null, "byte_limit");
                                        return null;
                                    }
                                    text.append(part, 0, count);
                                }
                                bytes = utf8(text.toString());
                            }
                        }
                    }
                    total += bytes == null ? 0 : bytes.length;
                    if (total > MAX_BYTES) {
                        overflow = true;
                        block(declaration.name(), null, "byte_limit");
                        return null;
                    }
                    fields.put(column.name(), new Cell(column.kind(), bytes));
                }
            } catch (IOException exception) {
                block(declaration.name(), null, "row_bytes_unavailable");
                return null;
            }
            List<Cell> key = declaration.keys().stream().map(fields::get).toList();
            if (key.stream().anyMatch(value -> value == null || value.isNull())) {
                block(declaration.name(), null, "invalid_primary_key");
                return null;
            }
            byte[] bytes = encode(out -> {
                out.writeInt(fields.size());
                for (var entry : fields.entrySet()) {
                    write(out, entry.getKey());
                    write(out, entry.getValue().kind.name());
                    write(out, entry.getValue().bytes);
                }
            });
            return new Row(key, fields, bytes, Membership.ORIGINAL);
        }

        private boolean schema(ResultSetMetaData metadata, Declaration declaration) throws SQLException {
            if (metadata.getColumnCount() != declaration.columns().size()) {
                return false;
            }
            for (int index = 0; index < declaration.columns().size(); index++) {
                Column column = declaration.columns().get(index);
                if (!column.name().equals(metadata.getColumnName(index + 1).toLowerCase(Locale.ROOT))
                        || !column.kind().accepts(metadata.getColumnType(index + 1))) {
                    return false;
                }
            }
            return true;
        }

        private Query predicate(String table) {
            return switch (table) {
                case "managed_agent_action", "managed_agent_command", "managed_agent_consumer_progress",
                        "managed_agent_event", "managed_agent_item", "managed_agent_item_part",
                        "managed_agent_operation", "managed_agent_snapshot", "managed_agent_turn" -> query("session_id=sessions");
                case "managed_agent_session" -> query("session_id=sessions", "runtime_request_key=requests",
                        "parent_session_id=sessions", "root_session_id=sessions");
                case "managed_agent_definition", "managed_agent_definition_command" -> query("tenant_id=T&agent_id=agent&revision=agentRevision");
                case "managed_session_create_scope" -> query("tenant_id=T&idempotency_key=creation");
                case "managed_workspace_create_command" -> query("session_id=sessions", "tenant_id=T&idempotency_key=creation");
                case "managed_workspace_access" -> query("tenant_id=T&workspace_id=W");
                case "managed_workspace_registry" -> query("tenant_id=T&workspace_id=W", "tenant_id=T&storage_id=D");
                case "managed_workspace_default" -> query("tenant_id=T");
                case "managed_workspace_csi_registration" -> query("alias_key=A", "physical_key=F", "tenant_id=T&storage_id=D");
                case "managed_workspace_csi_retirement" -> query("retirement_id=retirements", "binding_id=bindings", "physical_key=F");
                case "managed_workspace_csi_source" -> query("binding_id=bindings", "physical_key=F");
                case "managed_workspace_csi_worker_ack" -> query("retirement_id=retirements",
                        "execution_call_id_hash=executionHashes", "execution_call_id=executions");
                case "managed_workspace_execution_lease" -> query("storage_key=F|L", "binding_id=bindings",
                        "runtime_session_id=runtime", "tenant_id=T&storage_id=D", "csi_registration_key=A");
                case "qwen_runtime_binding_slot" -> query("request_key=requests", "active_binding_id=bindings",
                        "tenant_id=T&isolation_key=sessions");
                case "qwen_runtime_session" -> query("binding_id=bindings", "harness_session_id=sessions",
                        "runtime_session_id=runtime", "scope_key=Bscope&harness_session_id=sessions");
                case "qwen_runtime_placement_guard" -> query("tenant_key=BT", "tenant_id=T");
                case "qwen_tool_publication_tenant" -> query("tenant_key=RT", "tenant_id=T");
                case "qwen_runtime_harness_drain" -> query("tenant_key=BT&harness_key=BS", "harness_session_id=sessions");
                case "qwen_runtime_storage_fence" -> query("tenant_key=BT&storage_key=BD",
                        "tenant_id=T&storage_id=D", "operation_id=operations");
                case "qwen_managed_session_journal_head" -> query("session_id=sessions");
                case "qwen_managed_session_journal_tx" -> query("session_id=sessions", "transaction_id=transactions");
                case "qwen_managed_session_resource", "qwen_managed_session_resource_ref" ->
                        query("session_scope_key=J", "session_id=sessions", "resource_id=resources");
                case "qwen_managed_session_extension_record" -> query("session_scope_key=J", "session_id=sessions",
                        "record_resource_id=resources", "record_id=records");
                case "qwen_managed_session_task_journal", "qwen_managed_session_task_journal_cursor" ->
                        query("session_scope_key=J", "session_id=sessions", "task_id=tasks");
                case "qwen_csi_resource_read" -> query("session_id=sessions", "binding_id=bindings",
                        "request_key=requests", "read_id=reads", "resource_id=resources");
                case "qwen_output_read_lease" -> query("session_key=RS", "lease_id=reads", "tenant_key=RT&session_key=RS");
                case "qwen_output_session_retirement" -> query("session_key=RS", "session_id=sessions", "operation_id=operations");
                case "qwen_output_put_attempt" -> query("scope_key=U", "publication_id=publications",
                        "object_key=objects", "attempt_id=attempts");
                case "qwen_tool_publication_object", "qwen_tool_publication_operation", "qwen_tool_publication_seal" ->
                        query("scope_key=U", "publication_id=publications");
                case "qwen_managed_automation_command" -> new Query("1 = 1", List.of());
                case "qwen_managed_automation_schedule" -> query("session_id=sessions", "schedule_id=schedules");
                case "qwen_managed_automation_occurrence" -> query("session_id=sessions", "schedule_id=schedules",
                        "run_id=runs", "occurrence_key=automation");
                case "qwen_managed_channel_binding" -> query("session_id=sessions", "route_id=routes",
                        "tenant_id=T&channel_id=channels");
                case "qwen_managed_channel_claim" -> query("session_id=sessions", "delivery_id=deliveries",
                        "tenant_id=T&channel_id=channels");
                case "qwen_managed_channel_delivery" -> query("tenant_id=T", "delivery_id=deliveries", "channel_instance_id=channels");
                case "qwen_managed_channel_instance" -> query("tenant_id=T&workspace_id=W", "channel_id=channels");
                case "qwen_managed_channel_route" -> query("session_id=sessions", "route_key=routeKeys", "input_id=inputs",
                        "tenant_id=T&channel_instance_id=channels");
                case "qwen_managed_child_result_relay" -> query("parent_session_id=sessions", "child_session_id=sessions",
                        "child_run_id=childRuns", "creation_key=childCreation");
                case "qwen_managed_child_workspace" -> query("parent_session_id=sessions",
                        "child_workspace_id=childWorkspaces", "workspace_id=W&storage_id=D");
                case "managed_agent_artifact", "managed_agent_tool_result", "managed_workspace_migration",
                        "managed_workspace_operator_recovery", "managed_workspace_recovery_operation",
                        "managed_workspace_recovery_session", "managed_workspace_recovery_work",
                        "qwen_runtime_binding", "qwen_tool_execution", "qwen_tool_publication" ->
                        new Query("1 = 1", List.of());
                default -> throw new IllegalStateException("Undeclared inventory table");
            };
        }

        private Query query(String... terms) {
            List<String> alternatives = new ArrayList<>();
            List<String> arguments = new ArrayList<>();
            for (String term : terms) {
                List<String> conjunction = new ArrayList<>();
                List<String> parameters = new ArrayList<>();
                for (String part : term.split("&")) {
                    String[] pair = part.split("=");
                    Set<String> choices = new TreeSet<>();
                    for (String namespace : pair[1].split("\\|")) {
                        choices.addAll(values(namespace));
                    }
                    if (choices.isEmpty()) {
                        conjunction.add("1 = 0");
                    } else {
                        conjunction.add("t." + pair[0] + " IN (" + String.join(",", Collections.nCopies(choices.size(), "?")) + ")");
                        parameters.addAll(choices);
                    }
                }
                alternatives.add("(" + String.join(" AND ", conjunction) + ")");
                arguments.addAll(parameters);
            }
            return new Query(String.join(" OR ", alternatives), arguments);
        }

        private Membership membership(String table, Row row) throws SQLException {
            if (Set.of("managed_agent_definition", "managed_agent_definition_command", "managed_workspace_access",
                    "managed_workspace_default", "managed_workspace_registry", "qwen_managed_channel_instance",
                    "qwen_runtime_placement_guard", "qwen_tool_publication_tenant").contains(table)) {
                return Membership.CONTEXT;
            }
            if (table.equals("qwen_managed_automation_command")) {
                if (has("schedules", row.text("schedule_id")) || mentions(row)) {
                    return Membership.ORIGINAL;
                }
                Row schedule = lookup("qwen_managed_automation_schedule",
                        "tenant_id = ? AND schedule_id = ?", row.text("tenant_id"), row.text("schedule_id"));
                if (schedule != null && !session.equals(schedule.text("session_id"))
                        && otherSession(schedule.text("tenant_id"), schedule.text("workspace_id"), schedule.text("session_id"))
                        && jsonContains(row.text("result_json"), schedule.text("session_id"))
                        && jsonContains(row.text("result_json"), schedule.text("schedule_id"))) {
                    return Membership.OTHER;
                }
                block(table, key(row), "unresolved_command_owner");
                return Membership.ORIGINAL;
            }
            if (table.equals("qwen_managed_channel_delivery")) {
                if (has("deliveries", row.text("delivery_id"))) {
                    return Membership.ORIGINAL;
                }
                Row claim = lookup("qwen_managed_channel_claim", "tenant_id = ? AND channel_id = ? AND delivery_id = ?",
                        row.text("tenant_id"), row.text("channel_instance_id"), row.text("delivery_id"));
                if (claim != null && session.equals(claim.text("session_id"))) {
                    return Membership.ORIGINAL;
                }
                if (claim != null && otherSession(claim.text("tenant_id"), null, claim.text("session_id"))) {
                    return Membership.OTHER;
                }
                block(table, key(row), "unresolved_delivery_owner");
                return Membership.ORIGINAL;
            }
            if (wide(table)) {
                if (related(row) || mentions(row)) {
                    return Membership.ORIGINAL;
                }
                String owner = row.text("session_id");
                String ownerTenant = row.text("tenant_id");
                String ownerWorkspace = row.text("workspace_id");
                if (table.equals("qwen_runtime_binding") || table.equals("qwen_tool_execution")) {
                    Row binding = table.equals("qwen_runtime_binding") ? row
                            : lookup("qwen_runtime_binding", "binding_id = ?", row.text("binding_id"));
                    if (binding != null && otherBinding(binding)
                            && (table.equals("qwen_runtime_binding") || otherExecution(row, binding))) {
                        return Membership.OTHER;
                    }
                    block(table, key(row), "unresolved_candidate_owner");
                    return Membership.ORIGINAL;
                }
                if (otherSession(ownerTenant, ownerWorkspace, owner)) {
                    return Membership.OTHER;
                }
                block(table, key(row), "unresolved_candidate_owner");
                return Membership.ORIGINAL;
            }
            if (Set.of("qwen_managed_child_workspace", "qwen_managed_channel_binding", "qwen_managed_channel_claim",
                    "qwen_managed_channel_route").contains(table) && !related(row)) {
                String owner = table.equals("qwen_managed_child_workspace")
                        ? row.text("parent_session_id") : row.text("session_id");
                if (otherSession(row.text("tenant_id"), row.text("workspace_id"), owner)) {
                    return Membership.OTHER;
                }
                block(table, key(row), "unresolved_candidate_owner");
            }
            return Membership.ORIGINAL;
        }

        private static boolean wide(String table) {
            return Set.of("managed_agent_artifact", "managed_agent_tool_result", "managed_workspace_migration",
                    "managed_workspace_operator_recovery", "managed_workspace_recovery_operation",
                    "managed_workspace_recovery_session", "managed_workspace_recovery_work",
                    "qwen_runtime_binding", "qwen_tool_execution", "qwen_tool_publication").contains(table);
        }

        private boolean related(Row row) {
            for (String field : List.of("session_id", "harness_session_id", "isolation_key", "parent_session_id",
                    "root_session_id", "child_session_id")) {
                if (has("sessions", row.text(field))) {
                    return true;
                }
            }
            for (String[] pair : List.of(new String[] {"binding_id", "bindings"},
                    new String[] {"request_key", "requests"}, new String[] {"runtime_request_key", "requests"},
                    new String[] {"retirement_id", "retirements"}, new String[] {"physical_key", "F"},
                    new String[] {"resource_id", "resources"}, new String[] {"scope_key", "M"},
                    new String[] {"scope_key", "U"}, new String[] {"session_scope_key", "J"},
                    new String[] {"execution_call_id", "executions"}, new String[] {"execution_key", "executionKeys"},
                    new String[] {"execution_call_id_hash", "executionHashes"},
                    new String[] {"blocked_execution_call_id", "executions"},
                    new String[] {"runtime_session_id", "runtime"}, new String[] {"runtime_session_key", "runtimeKeys"},
                    new String[] {"runtime_instance_id", "runtime"}, new String[] {"scope_key", "Bscope"},
                    new String[] {"active_binding_id", "bindings"}, new String[] {"csi_registration_key", "A"},
                    new String[] {"operation_id", "operations"}, new String[] {"record_resource_id", "resources"},
                    new String[] {"transaction_id", "transactions"}, new String[] {"result_id", "results"},
                    new String[] {"artifact_id", "artifacts"}, new String[] {"holder_key", "holders"},
                    new String[] {"read_id", "reads"}, new String[] {"attempt_id", "attempts"},
                    new String[] {"object_key", "objects"}, new String[] {"publication_id", "publications"},
                    new String[] {"schedule_id", "schedules"}, new String[] {"task_id", "tasks"},
                    new String[] {"record_id", "records"}, new String[] {"child_run_id", "childRuns"})) {
                if (has(pair[1], row.text(pair[0]))) {
                    return true;
                }
            }
            return (row.cell("storage_id") != null && storage.equals(row.text("storage_id"))
                    && tenant.equals(row.text("tenant_id")))
                    || has("F", row.text("storage_key")) || has("L", row.text("storage_key"));
        }

        private boolean mentions(Row row) {
            String workKey = row.text("work_key");
            if (workKey != null) {
                for (String namespace : List.of("sessions", "bindings", "resources", "publications")) {
                    for (String value : values(namespace)) {
                        if (workKey.contains(value)) {
                            return true;
                        }
                    }
                }
            }
            for (var field : row.fields.entrySet()) {
                if (field.getKey().endsWith("_json") && !field.getValue().isNull()) {
                    JsonNode json = parse(field.getValue().text());
                    if (json == null) {
                        return true;
                    }
                    Set<String> strings = new LinkedHashSet<>();
                    leaves(json, strings);
                    for (String namespace : List.of("sessions", "bindings", "requests", "F", "resources",
                            "executions", "executionHashes", "executionKeys", "runtime", "runtimeKeys", "publications",
                            "schedules", "retirements", "A", "physicalMarkers", "results", "artifacts", "operations", "holders")) {
                        if (!Collections.disjoint(strings, values(namespace))) {
                            return true;
                        }
                    }
                }
            }
            return false;
        }

        private boolean otherSession(String otherTenant, String otherWorkspace, String otherId) throws SQLException {
            if (otherTenant == null || otherId == null || has("sessions", otherId)) {
                return false;
            }
            Row other = lookup("managed_agent_session", "session_id = ?", otherId);
            return other != null && otherTenant.equals(other.text("tenant_id"))
                    && otherId.equals(other.text("session_id"))
                    && (otherWorkspace == null || otherWorkspace.equals(other.text("workspace_id")))
                    && other.text("agent_id") != null && other.text("agent_revision") != null
                    && other.text("workspace_id") != null && other.number("workspace_generation") != null
                        && other.number("workspace_generation") > 0 && other.text("workspace_storage_id") != null
                        && other.text("context_config_ref") != null && other.number("context_revision") != null
                        && other.number("context_revision") > 0 && other.text("workspace_config_ref") != null
                        && other.text("workspace_policy_ref") != null
                        && ("sha256:" + hash(utf8(other.text("workspace_config_ref") + "\u0000"
                                + other.text("workspace_policy_ref")))).equals(other.text("context_config_ref"))
                        && !has("sessions", other.text("parent_session_id"))
                        && !has("sessions", other.text("root_session_id"));
        }

        private boolean otherBinding(Row row) throws SQLException {
            if (!otherSession(row.text("tenant_id"), row.text("workspace_id"), row.text("isolation_key"))) {
                return false;
            }
            Row parent = lookup("managed_agent_session", "tenant_id = ? AND session_id = ?",
                    row.text("tenant_id"), row.text("isolation_key"));
            try {
                var scope = new RuntimeScope(row.text("tenant_id"), row.text("workspace_id"),
                        row.text("workspace_generation"), row.text("canonical_cwd"),
                        row.text("capability_digest"), row.text("isolation_class"));
                var request = new RuntimeProvisionRequest(scope, row.text("isolation_key"),
                        row.text("provisioner_kind"), row.text("storage_id"));
                return parent != null && request.requestKey().equals(row.text("request_key"))
                        && request.requestKey().equals(parent.text("runtime_request_key"))
                        && digest(scope.getTenantId(), scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                                scope.getCanonicalCwd(), scope.getCapabilityDigest(), scope.getIsolationClass())
                                .equals(row.text("scope_key"))
                        && scope.getWorkspaceGeneration().equals(String.valueOf(parent.number("workspace_generation")))
                        && Objects.equals(request.getStorageId(), parent.text("workspace_storage_id"))
                        && row.number("runtime_generation") != null && row.number("runtime_generation") > 0
                        && (row.text("resource_handle_json") == null || !mentions(row));
            } catch (IllegalArgumentException exception) {
                return false;
            }
        }

        private static boolean otherExecution(Row row, Row binding) {
            JsonNode reference = parse(row.text("reference_json"));
            return reference != null && reference.isObject()
                    && Objects.equals(binding.text("isolation_key"), row.text("harness_session_id"))
                    && Objects.equals(binding.number("runtime_generation"), row.number("runtime_generation"))
                    && row.text("runtime_session_id") != null
                    && digest(row.text("runtime_session_id")).equals(row.text("runtime_session_key"))
                    && row.text("runtime_session_id").equals(reference.path("sessionId").textValue())
                    && row.text("execution_call_id") != null
                    && digest(row.text("execution_call_id")).equals(row.text("execution_call_id_hash"))
                    && row.text("idempotency_key") != null
                    && digest(row.text("idempotency_key")).equals(row.text("idempotency_key_hash"));
        }

        private Row lookup(String table, String predicate, String... parameters) throws SQLException {
            Declaration declaration = CATALOGUE.stream().filter(value -> value.name().equals(table)).findFirst().orElseThrow();
            try (var statement = connection.prepareStatement("SELECT t.* FROM " + table + " t WHERE " + predicate
                    + " ORDER BY " + String.join(",", declaration.keys()) + " LIMIT 2 FOR UPDATE")) {
                statement.setQueryTimeout(10);
                for (int index = 0; index < parameters.length; index++) {
                    statement.setString(index + 1, parameters[index]);
                }
                try (var result = statement.executeQuery()) {
                    if (!schema(result.getMetaData(), declaration)) {
                        block(table, null, "schema_drift");
                        return null;
                    }
                    if (!result.next()) {
                        return null;
                    }
                    Row row = read(result, declaration);
                    if (row == null || result.next()) {
                        block(table, null, "ambiguous_owner");
                        return null;
                    }
                    retainOther(table, row);
                    return row;
                }
            }
        }

        private void retainOther(String table, Row row) {
            String key = key(row);
            Row previous = tables.get(table).get(key);
            if (previous != null) {
                if (!Arrays.equals(previous.bytes, row.bytes)) {
                    block(table, key, "same_key_conflicting_bytes");
                }
            } else if (rowCount == MAX_ROWS || byteCount + row.bytes.length > MAX_BYTES) {
                overflow = true;
                block(table, key, "proof_budget");
            } else {
                tables.get(table).put(key, row.withMembership(Membership.OTHER));
                rowCount++;
                byteCount += row.bytes.length;
            }
        }

        private void expand(String table, Row row) {
            for (var field : row.fields.entrySet()) {
                if (field.getValue().isNull() || field.getValue().kind.binary()) {
                    continue;
                }
                seed(field.getKey(), field.getValue().text());
                if (field.getKey().endsWith("_json")) {
                    JsonNode json = parse(field.getValue().text());
                    if (json == null) {
                        block(table, key(row), "malformed_association_json");
                    } else {
                        seedJson(json);
                    }
                }
            }
            if (table.equals("managed_workspace_create_command")) {
                id("creation", row.text("idempotency_key"));
            }
            if (table.equals("managed_agent_session")) {
                id("agent", row.text("agent_id"));
                String revision = row.text("agent_revision");
                if (revision != null && revision.matches("[1-9][0-9]{0,18}")
                        && new BigInteger(revision).compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                    id("agentRevision", revision);
                }
            }
            if (table.equals("managed_workspace_csi_registration")) {
                WorkspaceCsiRegistration registration = registration(row.text("registration_json"));
                if (registration != null) {
                    id("physicalMarkers", registration.volumeHandle());
                    id("physicalMarkers", registration.pvcUid());
                    id("physicalMarkers", registration.pvUid());
                    id("physicalMarkers", registration.diskSerial());
                }
            }
            if (table.equals("qwen_managed_session_journal_tx")) {
                try {
                    for (JsonNode record : com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.records(row.binary("record_bytes"))) {
                        seedJson(record);
                    }
                } catch (RuntimeException exception) {
                    block(table, key(row), "malformed_native_records");
                }
            }
            if (table.equals("qwen_managed_session_resource") && row.binary("inline_bytes") != null) {
                JsonNode json = parse(row.binary("inline_bytes"));
                if (json == null) {
                    block(table, key(row), "malformed_native_resource");
                } else {
                    seedJson(json);
                }
            }
        }

        private void seed(String field, String value) {
            String namespace = switch (field) {
                case "session_id", "parent_session_id", "root_session_id", "child_session_id", "sessionId" -> "sessions";
                case "binding_id", "active_binding_id", "bindingId" -> "bindings";
                case "request_key", "runtime_request_key", "requestKey" -> "requests";
                case "runtime_session_id", "runtimeSessionId" -> "runtime";
                case "retirement_id", "retirementId" -> "retirements";
                case "operation_id", "operationId" -> "operations";
                case "resource_id", "record_resource_id", "resourceId" -> "resources";
                case "transaction_id", "transactionId" -> "transactions";
                case "execution_call_id", "blocked_execution_call_id", "executionCallId" -> "executions";
                case "execution_call_id_hash" -> "executionHashes";
                case "execution_key", "executionKey" -> "executionKeys";
                case "publication_id", "publicationId" -> "publications";
                case "result_id", "resultId" -> "results";
                case "artifact_id", "artifactId" -> "artifacts";
                case "schedule_id", "scheduleId" -> "schedules";
                case "run_id", "runId" -> "runs";
                case "occurrence_key", "occurrenceKey" -> "automation";
                case "channel_id", "channel_instance_id", "channelId", "channelInstanceId" -> "channels";
                case "delivery_id", "deliveryId" -> "deliveries";
                case "route_id", "routeId" -> "routes";
                case "route_key", "routeKey" -> "routeKeys";
                case "input_id", "inputId" -> "inputs";
                case "child_run_id", "parent_child_run_id", "childRunId" -> "childRuns";
                case "child_workspace_id", "childWorkspaceId" -> "childWorkspaces";
                case "creation_key", "creationKey" -> "childCreation";
                case "record_id", "recordId" -> "records";
                case "task_id", "taskId" -> "tasks";
                case "read_id", "readId" -> "reads";
                case "attempt_id", "attemptId" -> "attempts";
                case "object_key", "objectKey" -> "objects";
                case "holder_key", "holderKey" -> "holders";
                default -> null;
            };
            if (namespace != null) {
                id(namespace, value);
                if (namespace.equals("runtime")) {
                    id("runtimeKeys", digest(value));
                } else if (namespace.equals("executions")) {
                    id("executionHashes", digest(value));
                }
            }
        }

        private void seedJson(JsonNode json) {
            if (json.isObject()) {
                var fields = json.fields();
                while (fields.hasNext()) {
                    var field = fields.next();
                    if (field.getValue().isTextual()) {
                        seed(field.getKey(), field.getValue().textValue());
                    }
                    seedJson(field.getValue());
                }
            } else if (json.isArray()) {
                for (JsonNode item : json) {
                    seedJson(item);
                }
            }
        }

        private void validate() {
            for (var table : tables.entrySet()) {
                for (Row row : table.getValue().values()) {
                    if (row.membership != Membership.OTHER) {
                        try {
                            validateRow(table.getKey(), row);
                        } catch (IllegalArgumentException | IllegalStateException | com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException exception) {
                            block(table.getKey(), key(row), "invalid_typed_association");
                        }
                    }
                }
            }
            for (String table : List.of("managed_agent_session", "managed_agent_event", "managed_agent_consumer_progress",
                    "managed_workspace_create_command", "managed_session_create_scope", "managed_workspace_csi_registration",
                    "managed_workspace_csi_retirement", "managed_workspace_execution_lease", "qwen_runtime_binding",
                    "qwen_runtime_binding_slot", "qwen_runtime_session", "qwen_runtime_placement_guard",
                    "qwen_tool_publication_tenant", "qwen_managed_session_journal_head")) {
                if (rows(table).stream().filter(row -> row.membership != Membership.OTHER).count() != 1) {
                    block(table, null, "missing_or_extra_original");
                }
            }
            validateNativeMembership();
        }

        private void validateRow(String table, Row row) {
            switch (table) {
                case "managed_agent_session" -> {
                    expect(table, row, rawSession(row) && "ACTIVE".equals(row.text("status")) && row.cell("deleted_at").isNull()
                            && CsiFilesRetirementProfile.PROFILE.equals(row.text("tool_profile"))
                            && original.request().requestKey().equals(row.text("runtime_request_key"))
                            && workspace.equals(row.text("workspace_id")) && storage.equals(row.text("workspace_storage_id"))
                            && original.request().getScope().getWorkspaceGeneration().equals(String.valueOf(row.number("workspace_generation")))
                            && ".".equals(row.text("cwd_relative"))
                            && CsiFilesRetirementProfile.CONTEXT_CONFIG_REF.equals(row.text("context_config_ref"))
                            && CsiFilesRetirementProfile.CONFIG_REF.equals(row.text("workspace_config_ref"))
                            && CsiFilesRetirementProfile.POLICY_REF.equals(row.text("workspace_policy_ref"))
                            && row.number("context_revision") != null && row.number("context_revision") > 0
                            && "qwen-code".equals(row.text("agent_id")) && Boolean.TRUE.equals(row.bool("csi_guard"))
                            && row.cell("parent_session_id").isNull() && row.cell("root_session_id").isNull()
                            && row.cell("parent_child_run_id").isNull() && row.cell("child_depth").isNull()
                            && row.binary("creator_actor_key") != null
                            && Arrays.equals(row.binary("creator_actor_key"), row.binary("owner_actor_key"))
                            && row.text("agent_revision") != null && !row.text("agent_revision").isBlank()
                            && Objects.equals(1L, row.number("last_sequence")) && Objects.equals(1L, row.number("version"))
                            && Objects.equals(0L, row.number("replay_floor_sequence"))
                            && Objects.equals(0L, row.number("harness_last_event_id"))
                            && row.cell("harness_boot_id").isNull() && row.cell("harness_event_epoch").isNull()
                            && Objects.equals(row.number("created_at"), row.number("updated_at")));
                }
                case "managed_agent_consumer_progress" -> expect(table, row, rawSession(row)
                        && "message_projection".equals(row.text("consumer_name")) && Objects.equals(0L, row.number("covered_sequence"))
                        && row.cell("snapshot_stale_since").isNull()
                        && originalRow("managed_agent_session") != null
                        && Objects.equals(originalRow("managed_agent_session").number("created_at"), row.number("updated_at")));
                case "managed_agent_event" -> {
                    JsonNode data = parse(row.text("data_json"));
                    Row parent = originalRow("managed_agent_session");
                    expect(table, row, rawSession(row) && "session.created".equals(row.text("event_type"))
                            && row.cell("turn_id").isNull() && row.cell("source_key").isNull() && Boolean.FALSE.equals(row.bool("terminal"))
                            && Objects.equals(1L, row.number("sequence_id")) && data != null && data.isObject()
                            && data.size() == 1 && session.equals(data.path("sessionId").textValue())
                            && parent != null && Objects.equals(parent.number("created_at"), row.number("created_at"))
                            && Objects.equals(1L, row.number("schema_version")) && Objects.equals(1L, row.number("projection_version"))
                            && row.cell("item_id").isNull() && row.cell("content_part_id").isNull());
                }
                case "managed_workspace_create_command" -> {
                    Row parent = originalRow("managed_agent_session");
                    expect(table, row, rawSession(row) && row.cell("turn_id").isNull() && parent != null
                            && Arrays.equals(parent.binary("creator_actor_key"), row.binary("actor_id"))
                            && row.text("request_digest") != null
                            && Objects.equals(parent.number("created_at"), row.number("created_at")));
                }
                case "managed_session_create_scope" -> expect(table, row, tenant.equals(row.text("tenant_id"))
                        && has("creation", row.text("idempotency_key")) && Boolean.TRUE.equals(row.bool("workspace_bound")));
                case "qwen_runtime_placement_guard" -> expect(table, row, tenant.equals(row.text("tenant_id"))
                        && has("BT", row.text("tenant_key")));
                case "qwen_tool_publication_tenant" -> expect(table, row, tenant.equals(row.text("tenant_id"))
                        && has("RT", row.text("tenant_key")));
                case "managed_workspace_registry" -> {
                    if (workspace.equals(row.text("workspace_id"))) {
                        expect(table, row, tenant.equals(row.text("tenant_id")) && storage.equals(row.text("storage_id"))
                                && original.request().getScope().getWorkspaceGeneration().equals(String.valueOf(row.number("workspace_generation")))
                                && "ACTIVE".equals(row.text("state"))
                                && CsiFilesRetirementProfile.CONFIG_REF.equals(row.text("config_ref"))
                                && CsiFilesRetirementProfile.POLICY_REF.equals(row.text("policy_ref")));
                    } else {
                        expect(table, row, tenant.equals(row.text("tenant_id")) && row.text("workspace_id") != null
                                && storage.equals(row.text("storage_id")) && row.number("workspace_generation") != null);
                    }
                }
                case "managed_workspace_csi_registration" -> {
                    WorkspaceCsiRegistration registration = registration(row.text("registration_json"));
                    expect(table, row, registration != null && matches(parse(row.text("registration_json")), registration)
                            && tenant.equals(registration.tenantId()) && storage.equals(registration.storageId())
                            && registration.aliasKey().equals(row.text("alias_key")) && has("A", row.text("alias_key"))
                            && registration.physicalKey().equals(row.text("physical_key"))
                            && intent.physicalKey().equals(registration.physicalKey())
                            && Objects.equals(registration.revision(), row.number("registration_revision"))
                            && Objects.equals(intent.reservation().registrationRevision(), registration.revision())
                            && original.request().getScope().getCanonicalCwd().equals(registration.mountRoot()));
                }
                case "managed_workspace_csi_retirement" -> {
                    var value = parse(row.text("identity_json"));
                    expect(table, row, intent.operationId().equals(row.text("retirement_id"))
                            && original.bindingId().equals(row.text("binding_id"))
                            && Objects.equals(original.generation(), row.number("runtime_generation"))
                            && intent.physicalKey().equals(row.text("physical_key")) && "DRAINING".equals(row.text("phase"))
                            && matches(value, intent)
                            && "qwen-csi-application-retirement/1".equals(row.text("progress_format"))
                            && row.number("progress_version") != null && row.number("progress_version") > 0
                            && oneOf(row.text("progress_stage"), "SETTLING", "FROZEN", "CUT", "DRAINED")
                            && Objects.equals(Math.addExact(Instant.parse(intent.startedAt()).toEpochMilli(), 300_000),
                                    row.number("settlement_deadline_ms")));
                    for (String field : List.of("frozen_request", "cut", "finalize_receipt")) {
                        byte[] bytes = row.binary(field + "_bytes");
                        String digest = row.text(field + "_sha256");
                        expect(table, row, bytes == null ? digest == null : hash(bytes).equals(digest));
                    }
                }
                case "managed_workspace_csi_source" -> {
                    requireEncoded("PUBLISHED".equals(row.text("phase")) && row.number("runtime_generation") != null
                            && row.number("reservation_revision") != null && row.number("record_version") != null);
                    var configuration = WorkspaceCsiNodeSourceStore.decode(row.text("configuration_json"), WorkspaceCsiNodeSourceStore.Configuration.class);
                    var association = new WorkspaceCsiNodeSourceStore.Association(row.text("binding_id"), row.number("runtime_generation"),
                            row.text("physical_key"), row.text("reservation_id"), row.number("reservation_revision"), configuration,
                            row.text("phase"), row.number("record_version"), sourceEvidence(row, "arm"), row.text("pod_uid"),
                            row.text("gated_spec_sha256"), sourceEvidence(row, "bound"), sourceEvidence(row, "publication"));
                    WorkspaceCsiNodeSourceStore.validate(association);
                    var registered = originalRow("managed_workspace_csi_registration");
                    requireEncoded(registered != null);
                    var registration = registration(registered.text("registration_json"));
                    var handle = parse(intent.resourceHandleJson());
                    requireEncoded(registration != null && handle != null && handle.path("placement").isObject());
                    var placement = handle.path("placement");
                    var observed = WorkspaceCsiNodeSourceStore.validateEvidence(configuration, association.publication(), "PUBLISHED", association.podUid());
                    expect(table, row, original.bindingId().equals(association.bindingId())
                            && original.generation() == association.generation() && intent.physicalKey().equals(association.physicalKey())
                            && intent.reservation().reservationId().equals(association.reservationId())
                            && intent.reservation().revision() == association.reservationRevision()
                            && registration.namespace().equals(observed.scope().namespace())
                            && registration.driver().equals(observed.scope().driver()) && registration.volumeHandle().equals(observed.scope().volumeId())
                            && registration.pvUid().equals(observed.scope().pvUid()) && registration.pvcUid().equals(observed.scope().pvcUid())
                            && ("/var/lib/kubelet/pods/" + association.podUid() + "/volumes/kubernetes.io~csi/" + registration.pvName() + "/mount").equals(observed.scope().target())
                            && association.podUid().equals(placement.path("podUid").textValue())
                            && configuration.scope().podName().equals(placement.path("podName").textValue())
                            && configuration.node().name().equals(placement.path("nodeName").textValue())
                            && configuration.node().identity().nodeUid().equals(placement.path("nodeUid").textValue())
                            && ("containerd://" + observed.scope().containerId()).equals(placement.path("containerId").textValue())
                            && placement.path("image").isTextual() && placement.path("image").textValue().endsWith("@sha256:" + configuration.imageDigest()));
                }
                case "managed_workspace_execution_lease" -> expect(table, row,
                        intent.physicalKey().equals(row.text("storage_key")) && "CSI".equals(row.text("storage_kind"))
                        && "DRAINING".equals(row.text("csi_phase")) && original.bindingId().equals(row.text("binding_id"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && intent.reservation().reservationId().equals(row.text("csi_reservation_id"))
                        && intent.reservation().registrationKey().equals(row.text("csi_registration_key"))
                        && Objects.equals(intent.reservation().registrationRevision(), row.number("csi_registration_revision"))
                        && intent.reservation().provisionRequestId().equals(row.text("csi_provision_request_id"))
                        && CsiOwnershipRevision.reserved(intent.reservation().revision())
                        && Objects.equals(row.number("csi_revision"),
                                CsiOwnershipRevision.next(intent.reservation().revision()))
                        && row.cell("maintenance_id").isNull());
                case "qwen_runtime_binding_slot" -> expect(table, row, request(row)
                        && original.bindingId().equals(row.text("active_binding_id"))
                        && Objects.equals(original.generation(), row.number("last_generation")));
                case "qwen_runtime_binding" -> expect(table, row, request(row)
                        && original.bindingId().equals(row.text("binding_id")) && has("Bscope", row.text("scope_key"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && "DRAINING".equals(row.text("binding_state")) && Boolean.TRUE.equals(row.bool("drain_requested"))
                        && intent.runtimeInstanceId().equals(row.text("runtime_instance_id"))
                        && intent.leaseId().equals(row.text("runtime_lease_id")) && Objects.equals(intent.epoch(), row.number("runtime_epoch"))
                        && intent.resourceHandleJson().equals(row.text("resource_handle_json"))
                        && Objects.equals(intent.resourceHandleVersion().longValue(), row.number("resource_handle_version"))
                        && Objects.equals(intent.attestationGeneration(), row.number("attestation_generation")));
                case "qwen_runtime_session" -> expect(table, row, scope(row)
                        && original.bindingId().equals(row.text("binding_id")) && session.equals(row.text("runtime_session_id"))
                        && session.equals(row.text("harness_session_id")) && "bootstrap".equals(row.text("turn_kind"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && oneOf(row.text("session_state"), "READY", "RELEASED"));
                case "qwen_managed_session_journal_head" -> expect(table, row, rawNative(row)
                        && Objects.equals(1L, row.number("storage_version"))
                        && oneOf(row.text("state"), "ACTIVE", "SEALED") && "READY".equals(row.text("recovery_status"))
                        && row.cell("recovery_detail_code").isNull() && Objects.equals(0L, row.number("compacted_through_revision"))
                        && row.number("journal_revision") != null && row.number("journal_revision") > 0
                        && row.number("writer_generation") != null && row.number("writer_generation") > 0
                        && row.text("writer_id") != null && row.text("lease_token_hash") != null
                        && row.text("writer_lease_until") != null && row.text("activation_id") != null);
                case "qwen_managed_session_journal_tx" -> expect(table, row, rawNative(row)
                        && "identity".equals(row.text("record_encoding")) && row.binary("record_bytes") != null
                        && Objects.equals((long) row.binary("record_bytes").length, row.number("byte_length"))
                        && hash(row.binary("record_bytes")).equals(row.text("record_digest")));
                case "qwen_managed_session_resource" -> expect(table, row, rawNative(row)
                        && has("J", row.text("session_scope_key"))
                        && "MYSQL_INLINE".equals(row.text("storage_kind")) && "REFERENCED".equals(row.text("state"))
                        && row.binary("inline_bytes") != null
                        && Objects.equals((long) row.binary("inline_bytes").length, row.number("byte_length"))
                        && hash(row.binary("inline_bytes")).equals(row.text("sha256"))
                        && row.cell("object_key").isNull() && row.cell("object_version_id").isNull()
                        && row.cell("encryption_key_id").isNull());
                case "qwen_managed_session_resource_ref" -> expect(table, row, rawNative(row)
                        && has("J", row.text("session_scope_key")));
                case "qwen_tool_execution" -> expect(table, row, original.bindingId().equals(row.text("binding_id"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && session.equals(row.text("harness_session_id")) && session.equals(row.text("runtime_session_id"))
                        && digest(session).equals(row.text("runtime_session_key"))
                        && digest(row.text("execution_call_id")).equals(row.text("execution_call_id_hash"))
                        && digest(row.text("idempotency_key")).equals(row.text("idempotency_key_hash"))
                        && "SETTLED".equals(row.text("execution_state")) && row.text("settled_at") != null
                        && row.number("dispatch_generation") != null && row.number("dispatch_generation") > 0
                        && Objects.equals(row.number("dispatch_generation"), row.number("authorized_dispatch_generation"))
                        && row.number("authorized_binding_version") != null && row.number("authorized_binding_version") > 0
                        && row.number("authorized_binding_version") <= intent.sealedBindingVersion()
                        && row.text("native_authorization_json") != null && parse(row.text("native_authorization_json")) != null
                        && parse(row.text("reference_json")) != null && parse(row.text("result_json")) != null);
                case "qwen_csi_resource_read" -> expect(table, row, rawNative(row)
                        && original.bindingId().equals(row.text("binding_id"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && original.request().requestKey().equals(row.text("request_key"))
                        && "RETURNED".equals(row.text("state")) && "verified".equals(row.text("outcome_code"))
                        && row.number("ended_at") != null && row.number("started_at") != null
                        && row.number("delivery_expires_at") != null && row.number("ended_at") >= row.number("started_at")
                        && row.number("ended_at") < row.number("delivery_expires_at"));
                case "managed_workspace_access", "managed_workspace_default", "qwen_managed_channel_instance" -> {
                    expect(table, row, tenant.equals(row.text("tenant_id")));
                }
                case "managed_agent_definition", "managed_agent_definition_command" -> {
                    Row parent = originalRow("managed_agent_session");
                    expect(table, row, parent != null && tenant.equals(row.text("tenant_id"))
                            && Objects.equals(parent.text("agent_id"), row.text("agent_id"))
                            && Objects.equals(parent.text("agent_revision"), String.valueOf(row.number("revision"))));
                }
                default -> block(table, key(row), "unsupported_first_lane");
            }
        }

        private Row originalRow(String table) {
            var found = rows(table).stream().filter(row -> row.membership != Membership.OTHER).toList();
            return found.size() == 1 ? found.getFirst() : null;
        }

        private static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Evidence sourceEvidence(Row row, String prefix) {
            byte[] bytes = row.binary(prefix + "_bytes");
            requireEncoded(bytes != null && bytes.length <= WorkspaceCsiNodeSourceStore.EVIDENCE_LIMIT && row.number(prefix + "_sequence") != null);
            return com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.verify(bytes,
                    new com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.Cursor(row.number(prefix + "_sequence"), row.text(prefix + "_hash")));
        }

        private boolean rawSession(Row row) {
            return tenant.equals(row.text("tenant_id")) && session.equals(row.text("session_id"));
        }

        private boolean rawNative(Row row) {
            return rawSession(row) && workspace.equals(row.text("workspace_id"));
        }

        private boolean scope(Row row) {
            var scope = original.request().getScope();
            return tenant.equals(row.text("tenant_id")) && workspace.equals(row.text("workspace_id"))
                    && scope.getWorkspaceGeneration().equals(row.text("workspace_generation"))
                    && scope.getCanonicalCwd().equals(row.text("canonical_cwd"))
                    && scope.getCapabilityDigest().equals(row.text("capability_digest"))
                    && scope.getIsolationClass().equals(row.text("isolation_class"))
                    && has("Bscope", row.text("scope_key"));
        }

        private boolean request(Row row) {
            var scope = original.request().getScope();
            return tenant.equals(row.text("tenant_id")) && workspace.equals(row.text("workspace_id"))
                    && scope.getWorkspaceGeneration().equals(row.text("workspace_generation"))
                    && scope.getCanonicalCwd().equals(row.text("canonical_cwd"))
                    && scope.getCapabilityDigest().equals(row.text("capability_digest"))
                    && scope.getIsolationClass().equals(row.text("isolation_class"))
                    && session.equals(row.text("isolation_key")) && storage.equals(row.text("storage_id"))
                    && original.request().getProvisionerKind().equals(row.text("provisioner_kind"))
                    && original.request().requestKey().equals(row.text("request_key"));
        }

        private void expect(String table, Row row, boolean condition) {
            if (!condition) {
                block(table, key(row), "invalid_original_association");
            }
        }

        private void validateNativeMembership() {
            Row head = originalRow("qwen_managed_session_journal_head");
            var transactions = rows("qwen_managed_session_journal_tx").stream()
                    .filter(row -> row.membership != Membership.OTHER).sorted(WorkspaceCsiApplicationInventory::compareKeys).toList();
            long revision = 0;
            long sequence = 0;
            String previousDigest = null;
            for (Row transaction : transactions) {
                expect("qwen_managed_session_journal_tx", transaction,
                        Objects.equals(++revision, transaction.number("journal_revision"))
                        && (revision == 1 || Objects.equals(sequence + 1, transaction.number("first_sequence")))
                        && Objects.equals(previousDigest, transaction.text("previous_commit_digest")));
                Long next = transaction.number("last_sequence");
                if (next != null) {
                    sequence = next;
                }
                previousDigest = transaction.text("commit_digest");
            }
            if (head == null || !Objects.equals(revision, head.number("journal_revision"))
                    || !Objects.equals(sequence, head.number("committed_sequence"))
                    || !Objects.equals(previousDigest, head.text("last_commit_digest"))) {
                block("qwen_managed_session_journal_head", null, "journal_membership_mismatch");
            }
            Map<String, Row> resources = new LinkedHashMap<>();
            for (Row row : rows("qwen_managed_session_resource")) {
                if (resources.putIfAbsent(row.text("resource_id"), row) != null) {
                    block("qwen_managed_session_resource", key(row), "duplicate_resource_identity");
                }
            }
            Set<String> referenced = new LinkedHashSet<>();
            for (Row ref : rows("qwen_managed_session_resource_ref")) {
                referenced.add(ref.text("resource_id"));
                Long at = ref.number("journal_revision");
                expect("qwen_managed_session_resource_ref", ref, resources.containsKey(ref.text("resource_id"))
                        && at != null && at > 0 && at <= revision);
            }
            for (Row resource : resources.values()) {
                expect("qwen_managed_session_resource", resource, referenced.contains(resource.text("resource_id")));
            }
            for (Row read : rows("qwen_csi_resource_read")) {
                Row resource = resources.get(read.text("resource_id"));
                Row transaction = transactions.stream().filter(row -> Objects.equals(row.number("journal_revision"),
                        read.number("journal_revision"))).findFirst().orElse(null);
                expect("qwen_csi_resource_read", read, resource != null && transaction != null && head != null
                        && read.number("binding_version") != null && read.number("binding_version") > 0
                        && read.number("binding_version") <= intent.sealedBindingVersion()
                        && Objects.equals(transaction.text("writer_id"), read.text("writer_id"))
                        && Objects.equals(transaction.number("writer_generation"), read.number("writer_generation"))
                        && Objects.equals(transaction.text("writer_token_hash"), read.text("writer_token_hash"))
                        && Objects.equals(transaction.number("activation_epoch"), read.number("activation_epoch"))
                        && Objects.equals(head.text("activation_id"), read.text("activation_id"))
                        && Objects.equals(resource.text("state"), read.text("resource_state"))
                        && Objects.equals(resource.text("storage_kind"), read.text("storage_kind"))
                        && Objects.equals(resource.text("kind"), read.text("kind"))
                        && Objects.equals(resource.number("schema_version"), read.number("schema_version"))
                        && Objects.equals(resource.number("byte_length"), read.number("byte_length"))
                        && Objects.equals(resource.text("sha256"), read.text("sha256")));
            }
        }

        private void block(String table, String key, String code) { blockers.add(new Blocker(table, key, code)); }

        private List<Row> rows(String table) { return List.copyOf(tables.get(table).values()); }

        private Snapshot snapshot() {
            List<Table> result = new ArrayList<>();
            for (Declaration declaration : CATALOGUE) {
                List<Row> sorted = new ArrayList<>(tables.get(declaration.name()).values());
                sorted.sort(WorkspaceCsiApplicationInventory::compareKeys);
                result.add(new Table(declaration.name(), declaration.columns(), declaration.keys(), sorted));
            }
            List<Blocker> sorted = new ArrayList<>(blockers);
            sorted.sort(java.util.Comparator.comparing(Blocker::table)
                    .thenComparing(blocker -> Objects.toString(blocker.key(), ""))
                    .thenComparing(Blocker::code));
            Snapshot snapshot = new Snapshot(result, sorted, rowCount, byteCount);
            if (snapshot.bytes.length > MAX_BYTES) {
                sorted.add(new Blocker("inventory", null, "canonical_byte_limit"));
                snapshot = new Snapshot(result, sorted, rowCount, byteCount);
            }
            return snapshot;
        }
    }

    private record Query(String sql, List<String> arguments) {
        private Query { arguments = List.copyOf(arguments); }
    }

    static int compareKeys(Row left, Row right) {
        for (int index = 0; index < left.key.size(); index++) {
            Cell a = left.key.get(index);
            Cell b = right.key.get(index);
            int order = a.kind.integral() ? new BigInteger(a.text()).compareTo(new BigInteger(b.text()))
                    : Arrays.compareUnsigned(a.bytes, b.bytes);
            if (order != 0) {
                return order;
            }
        }
        return 0;
    }

    private static String key(Row row) {
        return Base64.getEncoder().encodeToString(encode(out -> {
            for (Cell cell : row.key) {
                write(out, cell.kind.name());
                write(out, cell.bytes);
            }
        }));
    }

    @FunctionalInterface
    private interface Encoder { void write(DataOutputStream out) throws IOException; }

    private static byte[] encode(Encoder encoder) {
        try {
            var bytes = new ByteArrayOutputStream();
            try (var output = new DataOutputStream(bytes)) {
                encoder.write(output);
            }
            return bytes.toByteArray();
        } catch (IOException exception) {
            throw new IllegalStateException("Inventory encoding failed", exception);
        }
    }

    private static void write(DataOutputStream output, String value) throws IOException {
        write(output, value == null ? null : utf8(value));
    }

    private static void write(DataOutputStream output, byte[] bytes) throws IOException {
        output.writeInt(bytes == null ? -1 : bytes.length);
        if (bytes != null) {
            output.write(bytes);
        }
    }

    private static JsonNode parse(String text) {
        return text == null ? null : parse(utf8(text));
    }

    private static JsonNode parse(byte[] bytes) {
        if (bytes == null) {
            return null;
        }
        try {
            return JSON.readTree(bytes);
        } catch (IOException exception) {
            return null;
        }
    }

    private static boolean jsonContains(String json, String text) {
        JsonNode parsed = parse(json);
        if (parsed == null || text == null) {
            return false;
        }
        Set<String> values = new LinkedHashSet<>();
        leaves(parsed, values);
        return values.contains(text);
    }

    private static void leaves(JsonNode json, Set<String> values) {
        if (json.isTextual()) {
            values.add(json.textValue());
        } else if (json.isContainerNode()) {
            for (JsonNode child : json) {
                leaves(child, values);
            }
        }
    }

    private static WorkspaceCsiRegistration registration(String text) {
        if (text == null) {
            return null;
        }
        try {
            return JSON.readValue(text, WorkspaceCsiRegistration.class);
        } catch (IOException | IllegalArgumentException exception) {
            return null;
        }
    }

    private static boolean matches(JsonNode observed, Object value) {
        try {
            return observed != null && observed.equals(parse(JSON.writeValueAsBytes(value)));
        } catch (IOException exception) {
            return false;
        }
    }

    private static boolean oneOf(String value, String... choices) {
        return value != null && List.of(choices).contains(value);
    }

    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static String digest(String... values) {
        return hash(encode(out -> {
            for (String value : values) {
                write(out, value);
            }
        }));
    }

    private static String hash(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException(exception);
        }
    }
}
