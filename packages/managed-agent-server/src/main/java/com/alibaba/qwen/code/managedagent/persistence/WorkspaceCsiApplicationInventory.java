package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.catalog.AgentDefinitionExtensions;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
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
import java.util.concurrent.TimeUnit;

/** Bounded current rows; caller fences and the native terminal proof remain required. */
final class WorkspaceCsiApplicationInventory {
    static final int MAX_ROWS = 4096;
    static final int MAX_BYTES = 32 * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final ObjectMapper PUBLIC_ARTIFACTS = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(64).maxStringLength(MAX_BYTES).build()).build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final List<Declaration> CATALOGUE = List.of(
            declaration("ma_agent_definition", "tenant_id,agent_id,revision",
                    "tenant_id:VARBINARY,agent_id:VARBINARY,revision:BIGINT,digest:VARCHAR,definition_json:LONGTEXT,"
                    + "gmt_create:BIGINT"),
            declaration("ma_artifact", "artifact_id",
                    "artifact_id:VARBINARY,result_id:VARBINARY,scope_key:CHAR,descriptor_json:MEDIUMTEXT,"
                    + "publication_id:VARBINARY,binding_json:MEDIUMTEXT,manifest_ref_json:MEDIUMTEXT,stream_id:VARBINARY,"
                    + "creation_sequence:BIGINT"),
            declaration("ma_channel_binding", "tenant_id,channel_id,route_id",
                    "tenant_id:VARBINARY,channel_id:VARBINARY,route_id:VARBINARY,session_id:VARBINARY,scope_kind:VARCHAR,"
                    + "sender_id:VARBINARY,chat_id:VARBINARY,thread_id:VARBINARY,gmt_create:BIGINT"),
            declaration("ma_channel_instance", "tenant_id,channel_id",
                    "tenant_id:VARBINARY,channel_id:VARBINARY,platform:VARCHAR,account_id:VARBINARY,"
                    + "account_generation:BIGINT,state:VARCHAR,actor_id:VARBINARY,workspace_id:VARBINARY,"
                    + "cwd_relative:VARCHAR,policy_json:LONGTEXT,gmt_create:BIGINT,gmt_modified:BIGINT"),
            declaration("ma_delivery", "delivery_key",
                    "delivery_key:CHAR,delivery_kind:VARCHAR,tenant_id:VARBINARY,channel_id:VARBINARY,"
                    + "delivery_id:VARBINARY,source_session_id:VARBINARY,target_session_id:VARBINARY,source_scope_key:CHAR,"
                    + "source_record_key:CHAR,source_revision:BIGINT,segment_id:VARBINARY,segment_ordinal:BIGINT,"
                    + "creation_key:VARBINARY,provider_id:VARBINARY,provider_receipt_json:LONGTEXT,request_digest:CHAR,"
                    + "payload_version:INT,payload_json:LONGTEXT,transport_state:VARCHAR,reception_state:VARCHAR,"
                    + "consumption_state:VARCHAR,claimed_at:BIGINT,reconcile_operation_id:VARBINARY,claim_owner:VARBINARY,"
                    + "claim_generation:BIGINT,claim_until:BIGINT,attempt_count:INT,available_at:BIGINT,last_error:VARCHAR,"
                    + "failure_code:VARCHAR,gmt_create:BIGINT,gmt_modified:BIGINT"),
            declaration("ma_event_stream", "tenant_id,session_id,stream_kind,stream_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,stream_kind:VARCHAR,stream_id:VARBINARY,last_sequence:BIGINT,"
                    + "replay_floor_sequence:BIGINT,covered_sequence:BIGINT,wake_covered_sequence:BIGINT,"
                    + "projection_version:INT,snapshot_stale_since:BIGINT,current_snapshot_id:VARBINARY,"
                    + "artifact_refs_resource_key:CHAR,output_ranges_json:LONGTEXT,projection_pending:BOOLEAN,"
                    + "gmt_modified:BIGINT"),
            declaration("ma_message", "tenant_id,session_id,item_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,item_id:VARBINARY,turn_id:VARBINARY,item_type:VARCHAR,"
                    + "item_role:VARCHAR,item_status:VARCHAR,attributes_json:LONGTEXT,first_sequence:BIGINT,"
                    + "last_sequence:BIGINT,gmt_create:BIGINT,gmt_modified:BIGINT,revision:BIGINT,parts_json:LONGTEXT,"
                    + "body_resource_key:CHAR,execution_key:CHAR,tool_call_key:CHAR,policy_version:VARBINARY"),
            declaration("ma_operation", "operation_key",
                    "operation_key:CHAR,scope_key:CHAR,session_scope_key:CHAR,operation_id:VARBINARY,"
                    + "operation_kind:VARCHAR,tenant_id:VARBINARY,session_id:VARBINARY,workspace_id:VARBINARY,"
                    + "target_kind:VARCHAR,target_key:CHAR,target_revision:BIGINT,target_id:VARBINARY,storage_key:CHAR,"
                    + "physical_key:CHAR,actor_key:VARBINARY,actor_id:VARBINARY,idempotency_key:VARBINARY,"
                    + "idempotency_digest:CHAR,request_digest:VARCHAR,actor_digest:VARCHAR,lifecycle_protocol_version:INT,"
                    + "lifecycle_effects_receipt_json:LONGTEXT,action_id:VARBINARY,task_id:VARBINARY,"
                    + "decision_receipt_id:VARBINARY,target_cwd_relative:VARCHAR,expected_context_revision:BIGINT,"
                    + "result_context_revision:BIGINT,payload_version:INT,request_json:LONGTEXT,result_json:LONGTEXT,"
                    + "state:VARCHAR,phase:VARCHAR,admission_stage:VARCHAR,delivery_state:VARCHAR,"
                    + "session_status_before:VARCHAR,receipt_id:VARBINARY,claim_owner:VARBINARY,claim_generation:BIGINT,"
                    + "claim_until:BIGINT,available_at:BIGINT,attempt_count:INT,budget_exempt_attempt:INT,deadline:BIGINT,"
                    + "recovery_deadline:BIGINT,execution_mode:VARCHAR,verification_request_json:LONGTEXT,"
                    + "verification_ready:BOOLEAN,verification_next_at:BIGINT,publication_id:VARBINARY,"
                    + "publication_command_id:VARBINARY,slot_key:VARBINARY,execution_key:CHAR,item_id:VARBINARY,"
                    + "policy_version:VARBINARY,failure_status:INT,failure_code:VARCHAR,gmt_create:BIGINT,gmt_modified:BIGINT,"
                    + "completed_at:BIGINT,progress_format:VARCHAR,progress_version:BIGINT,progress_stage:VARCHAR,"
                    + "settlement_deadline_ms:BIGINT,frozen_request_bytes:LONGBLOB,frozen_request_sha256:CHAR,"
                    + "cut_bytes:LONGBLOB,cut_sha256:CHAR,finalize_receipt_bytes:LONGBLOB,finalize_receipt_sha256:CHAR,"
                    + "csi_retirement_target_key:CHAR"),
            declaration("ma_operation_work", "operation_key,work_kind,target_key",
                    "operation_key:CHAR,work_kind:VARCHAR,target_key:CHAR,target_id:VARBINARY,tenant_id:VARBINARY,"
                    + "session_id:VARBINARY,storage_key:CHAR,physical_key:CHAR,state:VARCHAR,revision:BIGINT,"
                    + "payload_version:INT,payload_json:LONGTEXT,evidence_resource_key:CHAR,evidence_sha256:CHAR,"
                    + "gmt_create:BIGINT,gmt_modified:BIGINT"),
            declaration("ma_output_capture", "scope_key,publication_id",
                    "scope_key:CHAR,tenant_key:CHAR,tenant_id:VARBINARY,workspace_id:VARBINARY,session_id:VARBINARY,"
                    + "publication_id:VARBINARY,execution_key:CHAR,capture_id:VARBINARY,binding_json:MEDIUMTEXT,"
                    + "binding_digest:CHAR,token_hash:CHAR,state:VARCHAR,expires_at:BIGINT,capture_bytes:BIGINT,"
                    + "producer_bytes:BIGINT,admission_bytes:BIGINT,producer_phase:VARCHAR,quarantined:BOOLEAN,"
                    + "active_operation_id:VARBINARY,finish_operation_id:VARBINARY,finish_predecessor_id:VARBINARY,"
                    + "finish_digest:CHAR,terminal_resource_id:VARBINARY,admission_resource_id:VARBINARY,"
                    + "receipt_sequence:BIGINT,receipt_revision:BIGINT,capture_held_bytes:BIGINT,producer_held_bytes:BIGINT,"
                    + "admission_held_bytes:BIGINT,capture_used_bytes:BIGINT,producer_used_bytes:BIGINT,"
                    + "admission_used_bytes:BIGINT,retention_state:VARCHAR,write_evidence:BOOLEAN,accepted_complete:BOOLEAN,"
                    + "collected_at:BIGINT,collected_bytes:BIGINT,released_held_bytes:BIGINT,manifest_resource_key:CHAR,"
                    + "manifest_sha256:CHAR,seal_manifest_resource_key:CHAR,seal_manifest_sha256:CHAR,gmt_create:BIGINT,"
                    + "gmt_modified:BIGINT"),
            declaration("ma_public_event", "tenant_id,session_id,stream_kind,stream_id,sequence_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,sequence_id:BIGINT,event_id:VARBINARY,turn_id:VARBINARY,"
                    + "event_type:VARCHAR,data_json:LONGTEXT,terminal:BOOLEAN,source_key:VARBINARY,gmt_create:BIGINT,"
                    + "schema_version:INT,projection_version:INT,item_id:VARBINARY,content_part_id:VARBINARY,"
                    + "stream_kind:VARCHAR,stream_id:VARBINARY,state:VARCHAR,runtime_state:VARCHAR,text:LONGTEXT,"
                    + "truncated:BOOLEAN,artifact_id:VARBINARY,capture_id:VARBINARY,output_stream_id:VARBINARY,"
                    + "first_ordinal:BIGINT,end_ordinal:BIGINT,archived:BOOLEAN"),
            declaration("ma_read_lease", "lease_id",
                    "lease_id:VARBINARY,tenant_key:CHAR,session_key:CHAR,retirement_generation:BIGINT,expires_at:BIGINT"),
            declaration("ma_request_receipt", "receipt_key",
                    "receipt_key:CHAR,namespace:VARCHAR,tenant_key:CHAR,tenant_id:VARBINARY,scope_kind:VARCHAR,"
                    + "scope_key:CHAR,scope_id:VARBINARY,idempotency_key:VARBINARY,idempotency_digest:CHAR,"
                    + "request_digest:VARCHAR,actor_id:VARBINARY,operation:VARCHAR,state:VARCHAR,workspace_bound:BOOLEAN,"
                    + "session_id:VARBINARY,turn_id:VARBINARY,agent_id:VARBINARY,agent_revision:BIGINT,schedule_id:VARBINARY,"
                    + "channel_id:VARBINARY,account_generation:BIGINT,semantic_revision:BIGINT,action_id:VARBINARY,"
                    + "action_version:BIGINT,decision_scope_key:CHAR,mutation_attempt_sequence:BIGINT,"
                    + "session_status_before:VARCHAR,result_operation_key:CHAR,result_json:LONGTEXT,gmt_create:BIGINT,"
                    + "gmt_modified:BIGINT"),
            declaration("ma_resource", "resource_key",
                    "resource_key:CHAR,session_scope_key:CHAR,tenant_id:VARBINARY,workspace_id:VARBINARY,"
                    + "session_id:VARBINARY,resource_id:VARBINARY,kind:VARBINARY,schema_version:INT,byte_length:BIGINT,"
                    + "sha256:CHAR,storage_kind:VARCHAR,inline_bytes:LONGBLOB,object_key:VARBINARY,"
                    + "object_version_id:VARBINARY,encryption_key_id:VARBINARY,publish_command_id:VARBINARY,state:VARCHAR,"
                    + "snapshot_id:VARBINARY,snapshot_page_ordinal:INT,snapshot_page_first_sequence:BIGINT,"
                    + "snapshot_page_last_sequence:BIGINT,scope_key:CHAR,publication_id:VARBINARY,slot_key:VARBINARY,"
                    + "capture_state:VARCHAR,capture_object_key:VARBINARY,operation_id:VARBINARY,quarantine_reason:VARCHAR,"
                    + "deletion_operation_key:CHAR,gmt_create:BIGINT,last_verified_at:BIGINT,retention_until:BIGINT"),
            declaration("ma_resource_ref", "session_scope_key,owner_kind,owner_key,owner_revision,resource_key",
                    "session_scope_key:CHAR,owner_kind:VARCHAR,owner_key:CHAR,owner_revision:BIGINT,resource_key:CHAR,"
                    + "tenant_id:VARBINARY,workspace_id:VARBINARY,session_id:VARBINARY,journal_revision:BIGINT,"
                    + "resource_id:VARBINARY,gmt_create:BIGINT"),
            declaration("ma_runtime_binding", "binding_id",
                    "binding_id:VARBINARY,request_key:CHAR,scope_key:CHAR,tenant_id:VARBINARY,workspace_id:VARBINARY,"
                    + "workspace_generation:VARBINARY,canonical_cwd:VARCHAR,capability_digest:VARBINARY,"
                    + "isolation_class:VARCHAR,isolation_key:VARBINARY,provisioner_kind:VARCHAR,storage_id:VARBINARY,"
                    + "storage_alias_key:CHAR,runtime_generation:BIGINT,binding_state:VARCHAR,provision_request_id:VARBINARY,"
                    + "provision_seed_ciphertext:LONGTEXT,provision_seeded:BOOLEAN,credential_key_id:VARBINARY,"
                    + "resource_handle_version:INT,resource_handle_json:LONGTEXT,loss_evidence_json:LONGTEXT,"
                    + "stop_evidence_json:LONGTEXT,runtime_instance_id:VARBINARY,runtime_endpoint:VARCHAR,"
                    + "runtime_lease_id:VARBINARY,runtime_epoch:BIGINT,runtime_credential_ciphertext:LONGTEXT,"
                    + "runtime_credential_key_id:VARBINARY,attestation_generation:BIGINT,drain_requested:BOOLEAN,"
                    + "operation_owner:VARBINARY,operation_lease_until:BIGINT,operation_generation:BIGINT,"
                    + "record_version:BIGINT,last_health_at:BIGINT,last_reconciled_at:BIGINT,last_active_at:BIGINT,"
                    + "drain_receipt_json:LONGTEXT,first_activation_journal_revision:BIGINT"),
            declaration("ma_runtime_session", "scope_key,runtime_session_id",
                    "scope_key:CHAR,runtime_session_id:VARBINARY,tenant_id:VARBINARY,workspace_id:VARBINARY,"
                    + "workspace_generation:VARBINARY,canonical_cwd:VARCHAR,capability_digest:VARBINARY,"
                    + "isolation_class:VARCHAR,harness_session_id:VARBINARY,turn_kind:VARCHAR,binding_id:VARBINARY,"
                    + "runtime_generation:BIGINT,session_state:VARCHAR,record_version:BIGINT,last_active_at:BIGINT"),
            declaration("ma_runtime_slot", "request_key",
                    "request_key:CHAR,tenant_id:VARBINARY,workspace_id:VARBINARY,workspace_generation:VARBINARY,"
                    + "canonical_cwd:VARCHAR,capability_digest:VARBINARY,isolation_class:VARCHAR,isolation_key:VARBINARY,"
                    + "provisioner_kind:VARCHAR,storage_id:VARBINARY,last_generation:BIGINT,active_binding_id:VARBINARY"),
            declaration("ma_schedule", "tenant_id,schedule_id",
                    "tenant_id:VARBINARY,schedule_id:VARBINARY,session_id:VARBINARY,workspace_id:VARBINARY,"
                    + "actor_id:VARBINARY,record_revision:BIGINT,definition_revision:BIGINT,definition_digest:CHAR,"
                    + "goal:VARCHAR,cron:VARCHAR,timezone:VARCHAR,session_mode:VARCHAR,overlap:VARCHAR,catch_up:VARCHAR,"
                    + "catch_up_limit:BIGINT,enabled:BOOLEAN,state:VARCHAR,blocked_reason:VARCHAR,armed_at:BIGINT,"
                    + "watermark_slot:BIGINT,lease_owner:VARBINARY,lease_until:BIGINT,fence:BIGINT,gmt_create:BIGINT,"
                    + "gmt_modified:BIGINT"),
            declaration("ma_schedule_occurrence", "tenant_id,schedule_id,occurrence_key",
                    "tenant_id:VARBINARY,schedule_id:VARBINARY,occurrence_key:VARBINARY,run_id:VARBINARY,"
                    + "session_id:VARBINARY,slot:BIGINT,trigger_kind:VARCHAR,outcome:VARCHAR,reason:VARCHAR,"
                    + "definition_revision:BIGINT,fence:BIGINT,attempts:INT,next_retry_at:BIGINT,last_error:VARCHAR,"
                    + "gmt_create:BIGINT,gmt_modified:BIGINT"),
            declaration("ma_session", "tenant_id,session_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,agent_id:VARBINARY,title:VARCHAR,status:VARCHAR,"
                    + "harness_boot_id:VARBINARY,harness_event_epoch:VARBINARY,harness_last_event_id:BIGINT,"
                    + "gmt_create:BIGINT,gmt_modified:BIGINT,version:BIGINT,public_session_id:VARBINARY,deleted_at:BIGINT,"
                    + "workspace_id:VARBINARY,workspace_generation:BIGINT,workspace_storage_id:VARBINARY,"
                    + "cwd_relative:VARCHAR,context_config_ref:VARBINARY,context_revision:BIGINT,"
                    + "workspace_config_ref:VARBINARY,workspace_policy_ref:VARBINARY,agent_revision:VARCHAR,"
                    + "approval_mode:VARCHAR,tool_profile:VARCHAR,"
                    + "creator_actor_key:VARBINARY,owner_actor_key:VARBINARY,parent_session_id:VARBINARY,"
                    + "root_session_id:VARBINARY,parent_child_run_id:VARBINARY,child_depth:INT,"
                    + "agent_definition_digest:VARCHAR,session_kind:VARCHAR,tenant_key:CHAR,session_key:CHAR,"
                    + "session_scope_key:CHAR,title_revision:BIGINT,retirement_operation_id:VARBINARY,"
                    + "retirement_generation:BIGINT,retired_at:BIGINT,recovery_protected:BOOLEAN,"
                    + "resource_gc_completed:BOOLEAN,runtime_request_key:CHAR,csi_guard:BOOLEAN,"
                    + "model_id:VARBINARY,model_revision:BIGINT,selected_approval_mode:VARCHAR,approval_revision:BIGINT,"
                    + "plan_enabled:BOOLEAN"),
            declaration("ma_session_head", "tenant_key,harness_key",
                    "tenant_id:VARBINARY,workspace_id:VARBINARY,session_id:VARBINARY,storage_version:INT,state:VARCHAR,"
                    + "writer_generation:BIGINT,writer_id:VARBINARY,writer_lease_until:BIGINT,lease_token_hash:CHAR,"
                    + "journal_revision:BIGINT,committed_sequence:BIGINT,last_commit_digest:CHAR,activation_epoch:BIGINT,"
                    + "latest_checkpoint_resource_id:VARBINARY,compacted_through_revision:BIGINT,recovery_status:VARCHAR,"
                    + "recovery_detail_code:VARCHAR,gmt_create:BIGINT,gmt_modified:BIGINT,o3_backfill_revision:BIGINT,"
                    + "o3_backfill_through:BIGINT,o3_backfill_error:VARCHAR,o3_backfill_pending:BOOLEAN,"
                    + "activation_id:VARBINARY,activation_phase:VARCHAR,activation_event_epoch:BIGINT,"
                    + "activation_expires_at:BIGINT,activation_head_revision:BIGINT,tenant_key:CHAR,harness_key:CHAR,"
                    + "harness_session_id:VARBINARY,head_kind:VARCHAR,phase:VARCHAR,operation_id:VARBINARY,"
                    + "claim_generation:BIGINT,claim_lease_until:BIGINT,wake_pending:BOOLEAN,wake_head_revision:BIGINT,"
                    + "wake_retry_at:BIGINT,wake_scan_pending:BOOLEAN"),
            declaration("ma_session_journal_tx", "tenant_id,session_id,journal_revision",
                    "tenant_id:VARBINARY,workspace_id:VARBINARY,session_id:VARBINARY,journal_revision:BIGINT,"
                    + "command_key_hash:CHAR,transaction_id:VARBINARY,operation:LONGTEXT,command_id:VARBINARY,"
                    + "content_digest:CHAR,first_sequence:BIGINT,last_sequence:BIGINT,event_count:INT,events_digest:CHAR,"
                    + "previous_commit_digest:CHAR,commit_digest:CHAR,writer_generation:BIGINT,writer_id:VARBINARY,"
                    + "writer_token_hash:CHAR,activation_epoch:BIGINT,latest_checkpoint_resource_id:VARBINARY,"
                    + "record_encoding:VARCHAR,record_bytes:MEDIUMBLOB,byte_length:BIGINT,record_digest:CHAR,"
                    + "gmt_create:BIGINT"),
            declaration("ma_session_record", "session_scope_key,record_key",
                    "session_scope_key:CHAR,record_key:CHAR,tenant_id:VARBINARY,workspace_id:VARBINARY,"
                    + "session_id:VARBINARY,domain:VARCHAR,record_id:VARBINARY,operation_hash:CHAR,revision:BIGINT,"
                    + "record_resource_id:VARBINARY,task_kind:VARCHAR,task_state:VARCHAR,runtime_state:VARCHAR,"
                    + "definition_revision:BIGINT,delivery_target:VARCHAR,delivery_state:VARCHAR,gmt_create:BIGINT,"
                    + "started_at:BIGINT,settled_at:BIGINT,first_sequence:BIGINT,hook_once_key_hash:CHAR,"
                    + "hook_occurrence_hash:CHAR,hook_ordinal:BIGINT,hook_definition_hash:CHAR,record_kind:VARCHAR,"
                    + "state:VARCHAR,action_id:VARBINARY,action_version:BIGINT,decision_receipt_id:VARBINARY,"
                    + "decision_digest:CHAR,prompt_id:VARBINARY,turn_id:VARBINARY,options_json:LONGTEXT"),
            declaration("ma_snapshot", "tenant_id,session_id,snapshot_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,snapshot_id:VARBINARY,snapshot_version:BIGINT,"
                    + "covered_sequence:BIGINT,projection_version:INT,manifest_resource_key:CHAR,manifest_sha256:CHAR,"
                    + "item_count:BIGINT,state:VARCHAR,gmt_create:BIGINT,published_at:BIGINT,retain_until:BIGINT"),
            declaration("ma_storage", "alias_key",
                    "alias_key:CHAR,tenant_key:CHAR,storage_key:CHAR,tenant_id:VARBINARY,storage_id:VARBINARY,"
                    + "physical_key:CHAR,registration_state:VARCHAR,storage_kind:VARCHAR,registration_revision:BIGINT,"
                    + "registration_json:LONGTEXT,fence_operation_id:VARBINARY,mount_revision:BIGINT,gmt_create:BIGINT,"
                    + "gmt_modified:BIGINT"),
            declaration("ma_storage_owner", "storage_key",
                    "storage_key:CHAR,holder_key:CHAR,binding_id:VARBINARY,runtime_generation:BIGINT,"
                    + "runtime_session_id:VARBINARY,tenant_id:VARBINARY,storage_id:VARBINARY,mount_revision:BIGINT,"
                    + "mount_state:VARCHAR,mount_operation_id:CHAR,mount_completed_operation_id:CHAR,mount_root:VARCHAR,"
                    + "mount_host_id:VARCHAR,mount_device:VARCHAR,mount_inode:VARCHAR,mount_birth_time:VARCHAR,"
                    + "mount_registration_id:CHAR,storage_kind:VARCHAR,csi_phase:VARCHAR,csi_revision:BIGINT,"
                    + "csi_reservation_id:CHAR,csi_registration_key:CHAR,csi_registration_revision:BIGINT,"
                    + "csi_provision_request_id:VARBINARY,maintenance_id:CHAR,maintenance_generation:BIGINT,"
                    + "physical_key:CHAR"),
            declaration("ma_tenant_guard", "tenant_key,guard_domain",
                    "tenant_key:CHAR,tenant_id:VARBINARY,guard_domain:VARCHAR"),
            declaration("ma_tool_execution", "execution_call_id_hash",
                    "execution_call_id_hash:CHAR,execution_call_id:VARBINARY,idempotency_key_hash:CHAR,"
                    + "idempotency_key:VARBINARY,binding_id:VARBINARY,runtime_generation:BIGINT,harness_session_id:VARBINARY,"
                    + "runtime_session_id:VARBINARY,runtime_session_key:CHAR,turn_id:VARBINARY,tool_call_id:VARBINARY,"
                    + "request_digest:VARCHAR,reference_json:LONGTEXT,execution_state:VARCHAR,execution_status:VARCHAR,"
                    + "result_json:LONGTEXT,last_sequence:BIGINT,cancel_requested:BOOLEAN,dispatch_owner:VARBINARY,"
                    + "dispatch_lease_until:BIGINT,dispatch_generation:BIGINT,record_version:BIGINT,settled_at:BIGINT,"
                    + "abandoned_at:BIGINT,loss_evidence_id:VARBINARY,authorized_dispatch_generation:BIGINT,"
                    + "authorized_binding_version:BIGINT,native_authorization_json:LONGTEXT"),
            declaration("ma_turn", "tenant_id,session_id,turn_id",
                    "tenant_id:VARBINARY,session_id:VARBINARY,turn_id:VARBINARY,prompt_id:VARBINARY,input_json:LONGTEXT,"
                    + "payload_digest:VARCHAR,status:VARCHAR,submission_attempted:BOOLEAN,harness_event_epoch:VARBINARY,"
                    + "harness_last_event_id:BIGINT,dispatch_owner:VARBINARY,dispatch_lease_until:BIGINT,error_code:VARCHAR,"
                    + "error_message:VARCHAR,gmt_create:BIGINT,gmt_modified:BIGINT,completed_at:BIGINT,version:BIGINT,"
                    + "retry_count:INT,consecutive_failures:INT,budget_exempt_failures:INT,retry_after:BIGINT,"
                    + "model_id:VARBINARY,model_revision:BIGINT,approval_mode:VARCHAR,approval_revision:BIGINT,"
                    + "plan_enabled:BOOLEAN"),
            declaration("ma_workspace", "tenant_id,workspace_id",
                    "tenant_id:VARBINARY,workspace_id:VARBINARY,workspace_generation:BIGINT,storage_id:VARBINARY,"
                    + "display_name:VARCHAR,config_ref:VARBINARY,policy_ref:VARBINARY,state:VARCHAR,workspace_kind:VARCHAR,"
                    + "child_state:VARCHAR,parent_workspace_id:VARBINARY,parent_session_id:VARBINARY,child_run_id:VARBINARY,"
                    + "child_workspace_id:VARBINARY,parent_cwd_relative:VARCHAR,repository_relative:VARCHAR,"
                    + "child_cwd_relative:VARCHAR,base_commit:VARCHAR,result_commit:VARCHAR,parent_tree:VARCHAR,"
                    + "merged_tree:VARCHAR,finish_request:VARCHAR,outcome_code:VARCHAR,conflict_paths:LONGTEXT,"
                    + "last_error:VARCHAR,is_default:BOOLEAN,default_tenant:VARBINARY,gmt_create:BIGINT,gmt_modified:BIGINT"),
            declaration("ma_workspace_access", "tenant_id,workspace_id,actor_id",
                    "tenant_id:VARBINARY,workspace_id:VARBINARY,actor_id:VARBINARY,role:VARCHAR"));

    private static final Set<String> IDENTITY_FIELDS = Set.of(
            "account_id",
            "action_id",
            "activation_id",
            "active_binding_id",
            "active_operation_id",
            "admission_resource_id",
            "agent_id",
            "artifact_id",
            "binding_id",
            "capability_digest",
            "capture_id",
            "capture_object_key",
            "channel_id",
            "chat_id",
            "child_run_id",
            "child_workspace_id",
            "claim_owner",
            "command_id",
            "config_ref",
            "content_part_id",
            "context_config_ref",
            "creation_key",
            "credential_key_id",
            "csi_provision_request_id",
            "current_snapshot_id",
            "decision_receipt_id",
            "default_tenant",
            "delivery_id",
            "dispatch_owner",
            "encryption_key_id",
            "event_id",
            "execution_call_id",
            "fence_operation_id",
            "finish_operation_id",
            "finish_predecessor_id",
            "harness_boot_id",
            "harness_event_epoch",
            "harness_session_id",
            "idempotency_key",
            "isolation_key",
            "item_id",
            "kind",
            "latest_checkpoint_resource_id",
            "lease_id",
            "lease_owner",
            "loss_evidence_id",
            "model_id",
            "object_key",
            "object_version_id",
            "occurrence_key",
            "operation_id",
            "operation_owner",
            "output_stream_id",
            "parent_child_run_id",
            "parent_session_id",
            "parent_workspace_id",
            "policy_ref",
            "policy_version",
            "prompt_id",
            "provider_id",
            "provision_request_id",
            "public_session_id",
            "publication_command_id",
            "publication_id",
            "publish_command_id",
            "receipt_id",
            "reconcile_operation_id",
            "record_id",
            "record_resource_id",
            "resource_id",
            "result_id",
            "retirement_operation_id",
            "root_session_id",
            "route_id",
            "run_id",
            "runtime_credential_key_id",
            "runtime_instance_id",
            "runtime_lease_id",
            "runtime_session_id",
            "schedule_id",
            "scope_id",
            "segment_id",
            "sender_id",
            "session_id",
            "slot_key",
            "snapshot_id",
            "source_key",
            "source_session_id",
            "storage_id",
            "stream_id",
            "target_id",
            "target_session_id",
            "task_id",
            "tenant_id",
            "terminal_resource_id",
            "thread_id",
            "tool_call_id",
            "transaction_id",
            "turn_id",
            "workspace_config_ref",
            "workspace_generation",
            "workspace_id",
            "workspace_policy_ref",
            "workspace_storage_id",
            "writer_id");

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
        String identity() {
            if (kind != Kind.VARBINARY) {
                throw new IllegalStateException("Cell is not a binary identity");
            }
            if (bytes == null) {
                return null;
            }
            try {
                return strictText(bytes);
            } catch (IOException malformed) {
                throw new IllegalStateException("Identity is not valid UTF-8", malformed);
            }
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
            if (value == null) {
                return null;
            }
            if (value.kind() == Kind.VARBINARY) {
                requireEncoded(IDENTITY_FIELDS.contains(name));
                return value.identity();
            }
            return value.text();
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
                write(out, "qwen-csi-application-inventory/2");
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
        final Inspection inventory = new Inspection(target, original, intent);
        try {
            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.validate(target);
        } catch (SQLException mismatch) {
            inventory.block("inventory", null, "schema_drift");
            return inventory.snapshot();
        }
        inventory.discover();
        inventory.validate();
        return inventory.snapshot();
    }

    static List<Blocker> validateHistoricalBaseline(JdbcCsiFilesRetirementGuard.Original actual,
            WorkspaceCsiReservationStore.Retirement intent, Snapshot baseline) {
        requireEncoded(actual != null && actual.draining() && actual.generation() == 1 && intent != null
                && baseline != null && baseline.blockers().isEmpty()
                && actual.state() == com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.DRAINING);
        baseline = restoreCanonical(baseline.bytes());
        var saved = WorkspaceCsiApplicationImage.sole(baseline, "ma_runtime_binding");
        requireEncoded(saved.number("record_version") != null && saved.number("record_version") >= intent.sealedBindingVersion()
                && Objects.equals(saved.number("first_activation_journal_revision"), 2L)
                && actual.version() == saved.number("record_version"));
        WorkspaceCsiApplicationImage.expected(baseline, com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage.SETTLING,
                null, null, null);
        // Only the saved-row validators run here; no discover, membership lookup or SQL is invoked.
        final Inspection validation = new Inspection(null, actual, intent);
        var references = originalReferences(actual, intent, baseline);
        for (Row receipt : baseline.table("ma_request_receipt").rows()) {
            if (receipt.membership() == Membership.ORIGINAL && validation.rawSession(receipt)
                    && "SESSION_CREATE_ACTOR".equals(receipt.text("namespace"))) {
                validation.id("creation", receipt.text("idempotency_key"));
            }
        }
        for (Table table : baseline.tables()) {
            for (Row row : table.rows()) {
                if (row.membership() == Membership.OTHER) {
                    if (savedOriginalReference(table.name(), row, references)) {
                        validation.block(table.name(), key(row), "original_row_hidden_as_other");
                    }
                    continue;
                }
                if (validation.context(table.name(), row) != (row.membership() == Membership.CONTEXT)) {
                    validation.block(table.name(), key(row), "invalid_historical_membership");
                }
                validation.tables.get(table.name()).put(key(row), row);
                if (row.membership() == Membership.ORIGINAL) {
                    validation.expand(table.name(), row);
                }
            }
        }
        validation.validate();
        return List.copyOf(validation.blockers);
    }

    private static Map<String, Set<String>> originalReferences(JdbcCsiFilesRetirementGuard.Original actual,
            WorkspaceCsiReservationStore.Retirement intent, Snapshot baseline) {
        Set<String> executions = new LinkedHashSet<>();
        Set<String> executionHashes = new LinkedHashSet<>();
        Set<String> idempotencyHashes = new LinkedHashSet<>();
        for (Row row : baseline.table("ma_tool_execution").rows()) {
            if (row.membership() == Membership.ORIGINAL && actual.bindingId().equals(row.text("binding_id"))) {
                executions.add(row.text("execution_call_id"));
                requireEncoded(digest(row.text("execution_call_id")).equals(row.text("execution_call_id_hash"))
                        && digest(row.text("idempotency_key")).equals(row.text("idempotency_key_hash")));
                executionHashes.add(row.text("execution_call_id_hash"));
                idempotencyHashes.add(row.text("idempotency_key_hash"));
            }
        }
        String session = actual.request().getIsolationKey();
        String tenant = actual.request().getScope().getTenantId();
        Set<String> scopes = new LinkedHashSet<>();
        scopes.add(ManagedSessionStore.sessionScopeKey(tenant, session));
        scopes.add(ManagedToolResultStore.scope(tenant, session));
        scopes.add(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", tenant, session));
        try {
            scopes.add(hash(JSON.writeValueAsBytes(List.of(tenant, actual.request().getScope().getWorkspaceId(), session))));
        } catch (IOException encoding) {
            throw new IllegalArgumentException("Invalid original publication scope", encoding);
        }
        var references = new LinkedHashMap<>(Map.of(
                "session", Set.of(session), "binding", Set.of(actual.bindingId()),
                "request", Set.of(actual.request().requestKey()), "retirement", Set.of(intent.operationId()),
                "reservation", Set.of(intent.reservation().reservationId()),
                "provision", Set.of(intent.reservation().provisionRequestId()), "execution", Set.copyOf(executions),
                "scopedSession", Set.copyOf(scopes), "sessionKey", Set.of(ToolPublicationRetentionStore.hash(session))));
        references.put("tenant", Set.of(tenant));
        references.put("executionHash", Set.copyOf(executionHashes));
        var operationExecutions = new LinkedHashSet<>(executionHashes);
        executions.forEach(value -> operationExecutions.add(hash(utf8(value))));
        references.put("operationExecutionHash", Set.copyOf(operationExecutions));
        references.put("publicationExecutionHash", executions.stream().map(value -> hash(utf8(value)))
                .collect(java.util.stream.Collectors.toUnmodifiableSet()));
        references.put("executionIdempotencyHash", Set.copyOf(idempotencyHashes));
        Set<String> reads = new LinkedHashSet<>();
        for (Row row : baseline.table("ma_request_receipt").rows()) {
            if (row.membership() == Membership.ORIGINAL && isNativeRead(row)) {
                var read = nativeReadEvidence(row);
                requireEncoded(actual.bindingId().equals(read.text("binding_id"))
                        && actual.request().requestKey().equals(read.text("request_key"))
                        && actual.request().getIsolationKey().equals(read.text("session_id"))
                        && Objects.equals(read.number("runtime_generation"), actual.generation()));
                reads.add(read.text("read_id"));
            }
        }
        references.put("resourceRead", Set.copyOf(reads));
        references.put("operationKey", Set.of(WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, intent.operationId())));
        references.put("resourceKey", baseline.table("ma_resource").rows().stream().filter(row -> row.membership == Membership.ORIGINAL)
                .map(row -> row.text("resource_key")).collect(java.util.stream.Collectors.toUnmodifiableSet()));
        return Collections.unmodifiableMap(references);
    }

    static WorkspaceCsiReservationStore.Retirement retirement(Row row) {
        var fields = new LinkedHashMap<String, Object>();
        for (String name : List.of("tenant_id", "operation_id", "operation_key", "operation_kind", "scope_key", "target_kind",
                "target_id", "target_key", "storage_key", "physical_key", "request_json", "request_digest", "result_json", "phase", "state")) {
            fields.put(name, row.text(name));
        }
        fields.put("target_revision", row.number("target_revision"));
        fields.put("payload_version", row.number("payload_version"));
        var immutable = WorkspaceCsiApplicationJson.typedObject(row.binary("request_json"), 256 * 1024, WorkspaceCsiReservationStore.Retirement.class);
        requireEncoded(immutable.equals(WorkspaceCsiReservationStore.decodeRetirement(fields, JSON)));
        return immutable;
    }

    private static boolean chunkManifest(String kind) {
        return "managed-message-chunks".equals(kind) || "managed-tool-outcome-chunks".equals(kind);
    }

    private static boolean chunkPart(String kind) {
        return "managed-message-part".equals(kind) || "managed-tool-outcome-part".equals(kind);
    }

    private static Row chunkMember(Row manifest, JsonNode ref, java.util.Collection<Row> resources) {
        var members = resources.stream().filter(row -> manifest.text("session_scope_key").equals(row.text("session_scope_key"))
                && ref.path("resourceId").textValue().equals(row.text("resource_id"))).toList();
        requireEncoded(members.size() == 1);
        return members.getFirst();
    }

    private static JsonNode chunkBody(Row manifest, java.util.function.Function<JsonNode, Row> members, Set<String> consumed) {
        java.util.function.Function<JsonNode, byte[]> reader = ref -> {
            Row part = members.apply(ref);
            for (String field : List.of("tenant_id", "workspace_id", "session_id", "session_scope_key")) {
                requireEncoded(Objects.equals(manifest.text(field), part.text(field)));
            }
            requireEncoded(ManagedSessionStore.sessionScopeKey(part.text("tenant_id"), part.text("session_id"))
                    .equals(part.text("session_scope_key"))
                    && ManagedSessionStore.resourceKey(part.text("session_scope_key"), part.text("resource_id")).equals(part.text("resource_key"))
                    && Objects.equals(part.text("kind"), ref.path("kind").textValue())
                    && Objects.equals(part.number("schema_version"), ref.path("schemaVersion").longValue())
                    && Objects.equals(part.number("byte_length"), ref.path("byteLength").longValue())
                    && Objects.equals(part.text("sha256"), ref.path("digest").textValue())
                    && "MYSQL_INLINE".equals(part.text("storage_kind"))
                    && part.text("object_key") == null && part.text("object_version_id") == null
                    && part.text("encryption_key_id") == null && Set.of("PUBLISHED", "REFERENCED").contains(part.text("state")));
            byte[] bytes = HistoricalScan.payload(part, "inline_bytes", "sha256", 8 * 1024 * 1024);
            if (chunkPart(part.text("kind"))) {
                consumed.add(key(part));
            }
            return bytes;
        };
        return "managed-tool-outcome-chunks".equals(manifest.text("kind"))
                ? CsiNativeActivationProof.toolOutcomeBody(HistoricalScan.resourceRef(manifest), reader)
                : CsiNativeActivationProof.messageBody(HistoricalScan.resourceRef(manifest), reader);
    }

    private static boolean isNativeRead(Row row) {
        return "SESSION_COMMAND".equals(row.text("namespace")) && "CSI_RESOURCE_READ".equals(row.text("operation"));
    }

    /** The existing Hosted producer derives exactly one latest-usage row from committed native events. */
    static Row modelContextReference(List<Row> transactions, List<Row> records, List<Row> resources,
            List<Row> references, RuntimeProvisionRequest original, long deadline) {
        var projected = records.stream().filter(row -> row.membership() == Membership.ORIGINAL).toList();
        var derived = references.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && "SESSION_RECORD".equals(row.text("owner_kind"))).toList();
        JsonNode first = null;
        JsonNode latest = null;
        Row latestTransaction = null;
        String tenant = original.getScope().getTenantId();
        String workspace = original.getScope().getWorkspaceId();
        String session = original.getIsolationKey();
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String key = ManagedExtensionProjection.recordKey(session, "hosted_context_usage", "latest");
        for (Row transaction : transactions.stream().filter(row -> row.membership() == Membership.ORIGINAL)
                .sorted(java.util.Comparator.comparingLong(row -> row.number("journal_revision"))).toList()) {
            byte[] raw = HistoricalScan.payload(transaction, "record_bytes", "record_digest", 8 * 1024 * 1024);
            requireEncoded("identity".equals(transaction.text("record_encoding")));
            for (JsonNode record : CsiNativeActivationProof.records(raw)) {
                JsonNode event = record.path("managedSession");
                if (!"managed_session_event_v1".equals(record.path("subtype").textValue())
                        || !"model.attempt".equals(event.path("kind").textValue())
                        || !"output_committed".equals(event.path("payload").path("state").textValue())) {
                    continue;
                }
                JsonNode sessionKey = event.path("sessionKey");
                WorkspaceCsiApplicationJson.closed(sessionKey, Set.of("tenantId", "workspaceId", "sessionId"));
                requireEncoded(tenant.equals(sessionKey.path("tenantId").textValue())
                        && workspace.equals(sessionKey.path("workspaceId").textValue())
                        && session.equals(sessionKey.path("sessionId").textValue()));
                ManagedExtensionRecords.count(event.get("v"), 1, 1, "event.v");
                long sequence = ManagedExtensionRecords.count(event.get("sequence"), 1, 9_007_199_254_740_991L, "event.sequence");
                ManagedExtensionRecords.count(event.get("occurredAt"), 0, ManagedExtensionRecords.MAX_TIME, "event.occurredAt");
                requireEncoded(latest == null || sequence > latest.path("sequence").longValue());
                if (first == null) {
                    first = event;
                }
                latest = event;
                latestTransaction = transaction;
            }
        }
        if (latest == null) {
            requireEncoded(projected.isEmpty() && derived.isEmpty());
            return null;
        }
        requireEncoded(projected.size() == 1 && derived.size() == 1);
        JsonNode usage = latest.path("payload").path("usageRef");
        WorkspaceCsiApplicationJson.closed(usage, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        String resourceId = usage.path("resourceId").textValue();
        var matching = resources.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && Objects.equals(resourceId, row.text("resource_id"))).toList();
        requireEncoded(matching.size() == 1);
        Row resource = matching.getFirst();
        HistoricalScan.resourceMetadata(resource);
        requireEncoded(tenant.equals(resource.text("tenant_id")) && workspace.equals(resource.text("workspace_id"))
                && session.equals(resource.text("session_id")) && "REFERENCED".equals(resource.text("state"))
                && "managed-hosted-model-usage".equals(resource.text("kind"))
                && "managed-hosted-model-usage".equals(usage.path("kind").textValue())
                && ManagedExtensionRecords.count(usage.get("schemaVersion"), 1, 1, "usage.schemaVersion") == 1
                && Objects.equals(resource.number("byte_length"),
                        ManagedExtensionRecords.count(usage.get("byteLength"), 1, ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES, "usage.byteLength"))
                && Objects.equals(resource.text("sha256"), usage.path("digest").textValue()));
        HistoricalScan.payload(resource, "inline_bytes", "sha256", ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        long revision = latest.path("sequence").longValue();
        Map<String, byte[]> values = new LinkedHashMap<>();
        CATALOGUE.stream().filter(table -> table.name().equals("ma_session_record")).findFirst().orElseThrow()
                .columns().forEach(column -> values.put(column.name(), null));
        Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("record_key", key),
                Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                Map.entry("domain", "hosted_context_usage"), Map.entry("record_id", "latest"), Map.entry("record_kind", "DOMAIN"),
                Map.entry("revision", Long.toString(revision)), Map.entry("record_resource_id", resourceId),
                Map.entry("gmt_create", first.path("occurredAt").asText()), Map.entry("settled_at", latest.path("occurredAt").asText()),
                Map.entry("first_sequence", first.path("sequence").asText())).forEach((field, value) -> values.put(field, utf8(value)));
        requireEncoded(Arrays.equals(projected.getFirst().bytes(), expectedRow("ma_session_record", values, Membership.ORIGINAL).bytes()));
        Row ref = derived.getFirst();
        requireEncoded(ref.number("gmt_create") != null && latestTransaction.number("gmt_create") != null
                && ref.number("gmt_create") >= latestTransaction.number("gmt_create") && ref.number("gmt_create") <= deadline);
        values.clear();
        CATALOGUE.stream().filter(table -> table.name().equals("ma_resource_ref")).findFirst().orElseThrow()
                .columns().forEach(column -> values.put(column.name(), null));
        Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("owner_kind", "SESSION_RECORD"), Map.entry("owner_key", key),
                Map.entry("owner_revision", Long.toString(revision)), Map.entry("resource_key", ManagedSessionStore.resourceKey(scope, resourceId)),
                Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                Map.entry("resource_id", resourceId), Map.entry("gmt_create", ref.text("gmt_create")))
                .forEach((field, value) -> values.put(field, utf8(value)));
        requireEncoded(Arrays.equals(ref.bytes(), expectedRow("ma_resource_ref", values, Membership.ORIGINAL).bytes()));
        long journalRevision = latestTransaction.number("journal_revision");
        requireEncoded(references.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && "JOURNAL".equals(row.text("owner_kind")) && scope.equals(row.text("session_scope_key"))
                && scope.equals(row.text("owner_key")) && Objects.equals(row.number("journal_revision"), journalRevision)
                && Objects.equals(row.number("owner_revision"), journalRevision)
                && Objects.equals(row.text("resource_key"), resource.text("resource_key"))
                && tenant.equals(row.text("tenant_id")) && workspace.equals(row.text("workspace_id"))
                && session.equals(row.text("session_id")) && resourceId.equals(row.text("resource_id"))).count() == 1);
        return ref;
    }

    private record NativeReadEvidence(JsonNode value) {
        String text(String field) { return value.path(field).textValue(); }
        Long number(String field) { return value.path(field).isIntegralNumber() ? value.path(field).longValue() : null; }
    }

    private static NativeReadEvidence nativeReadEvidence(Row row) {
        requireEncoded(isNativeRead(row));
        JsonNode evidence = WorkspaceCsiApplicationJson.object(row.binary("result_json"), 64 * 1024);
        Set<String> fields = new LinkedHashSet<>(List.of("read_id", "tenant_id", "workspace_id", "session_id",
                "request_key", "binding_id", "runtime_generation", "binding_version", "writer_id", "writer_generation",
                "writer_token_hash", "journal_revision", "activation_id", "activation_epoch", "resource_id", "kind",
                "schema_version", "byte_length", "sha256", "storage_kind", "resource_state", "started_at", "delivery_expires_at"));
        String state = row.text("state");
        requireEncoded(Set.of("OPEN", "UNKNOWN", "RETURNED").contains(state));
        if (!"OPEN".equals(state)) {
            fields.addAll(Set.of("ended_at", "outcome_code"));
        }
        WorkspaceCsiApplicationJson.closed(evidence, fields);
        for (String field : List.of("read_id", "tenant_id", "workspace_id", "session_id", "request_key", "binding_id",
                "writer_id", "writer_token_hash", "resource_id", "kind", "sha256", "storage_kind", "resource_state")) {
            requireEncoded(evidence.path(field).isTextual() && !evidence.path(field).textValue().isEmpty());
        }
        requireEncoded(evidence.path("activation_id").isNull()
                || evidence.path("activation_id").isTextual() && !evidence.path("activation_id").textValue().isEmpty());
        for (String field : List.of("runtime_generation", "binding_version", "writer_generation", "journal_revision",
                "activation_epoch", "schema_version", "byte_length", "started_at", "delivery_expires_at")) {
            requireEncoded(evidence.path(field).isIntegralNumber() && evidence.path(field).canConvertToLong()
                    && evidence.path(field).longValue() >= 0);
        }
        var read = new NativeReadEvidence(evidence);
        String id = read.text("read_id");
        requireEncoded(java.util.UUID.fromString(id).toString().equals(id)
                && read.text("request_key").matches("[0-9a-f]{64}") && read.text("writer_token_hash").matches("[0-9a-f]{64}")
                && read.text("sha256").matches("[0-9a-f]{64}") && read.number("runtime_generation") > 0
                && read.number("binding_version") > 0 && read.number("writer_generation") > 0
                && read.number("journal_revision") > 0 && read.number("schema_version") > 0
                && read.number("delivery_expires_at") > read.number("started_at"));
        var initial = evidence.deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) initial).remove(List.of("ended_at", "outcome_code"));
        requireEncoded(com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", id).equals(row.text("receipt_key"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(read.text("tenant_id")).equals(row.text("tenant_key"))
                && read.text("tenant_id").equals(row.text("tenant_id")) && "SESSION".equals(row.text("scope_kind"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", read.text("tenant_id"),
                        read.text("session_id")).equals(row.text("scope_key"))
                && read.text("session_id").equals(row.text("scope_id")) && read.text("session_id").equals(row.text("session_id"))
                && id.equals(row.text("idempotency_key"))
                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(id).equals(row.text("idempotency_digest"))
                && hash(utf8(initial.toString())).equals(row.text("request_digest"))
                && Objects.equals(read.number("started_at"), row.number("gmt_create"))
                && row.number("gmt_modified") != null && row.number("gmt_modified") >= read.number("started_at"));
        for (String field : List.of("actor_id", "workspace_bound", "turn_id", "agent_id", "agent_revision", "schedule_id",
                "channel_id", "account_generation", "semantic_revision", "action_id", "action_version", "decision_scope_key",
                "mutation_attempt_sequence", "session_status_before", "result_operation_key")) {
            requireEncoded(row.cell(field).isNull());
        }
        if ("OPEN".equals(state)) {
            requireEncoded(Objects.equals(row.number("gmt_create"), row.number("gmt_modified")));
        } else {
            requireEncoded(evidence.path("outcome_code").isTextual() && !read.text("outcome_code").isEmpty());
            if ("UNKNOWN".equals(state)) {
                requireEncoded(evidence.path("ended_at").isNull() && "jdbc_fetch_unknown".equals(read.text("outcome_code")));
            } else {
                requireEncoded(evidence.path("ended_at").isIntegralNumber() && evidence.path("ended_at").canConvertToLong()
                        && read.number("ended_at") >= read.number("started_at") && read.number("ended_at") <= row.number("gmt_modified"));
            }
        }
        return read;
    }

    private static boolean savedOriginalReference(String table, Row row, Map<String, Set<String>> references) {
        for (var field : row.fields().entrySet()) {
            Cell cell = field.getValue();
            if (cell.isNull()) {
                continue;
            }
            String namespace = typedReferenceNamespace(table, row, field.getKey());
            if (namespace != null && (cell.kind() == Kind.VARBINARY && IDENTITY_FIELDS.contains(field.getKey()) || !cell.kind().binary())
                    && references.getOrDefault(namespace, Set.of()).contains(row.text(field.getKey()))
                    && localReferenceMatches(namespace, row.text("tenant_id"), references)) {
                return true;
            }
            if (field.getKey().endsWith("_json") || "artifact_refs".equals(field.getKey())) {
                JsonNode value = parse(cell.bytes());
                requireEncoded(value != null);
                if (savedJsonReference(value, references, 0,
                        "ma_operation".equals(table) && "CSI_RETIREMENT".equals(row.text("operation_kind")) && "request_json".equals(field.getKey()))) {
                    return true;
                }
            }
        }
        if ("ma_resource".equals(table) && "managed-tool-input".equals(row.text("kind"))) {
            JsonNode wrapper = parse(row.binary("inline_bytes"));
            WorkspaceCsiApplicationJson.closed(wrapper, Set.of("harnessSessionId", "runtimeSessionId", "payloadJson"));
            requireEncoded(wrapper.path("payloadJson").isTextual());
            JsonNode payload = parse(wrapper.path("payloadJson").textValue());
            requireEncoded(payload != null);
            return savedJsonReference(wrapper, references, 0, false) || savedJsonReference(payload, references, 0, false);
        }
        return false;
    }

    private static boolean savedJsonReference(JsonNode value, Map<String, Set<String>> references, int depth, boolean identity) {
        return savedJsonReference(value, references, depth, identity, null);
    }

    private static boolean savedJsonReference(JsonNode value, Map<String, Set<String>> references, int depth, boolean identity,
            String ownerTenant) {
        requireEncoded(depth <= 64);
        if (value.isObject()) {
            JsonNode declaredTenant = value.has("tenantId") ? value.get("tenantId") : value.get("tenant_id");
            if (declaredTenant != null) {
                requireEncoded(declaredTenant.isTextual());
                ownerTenant = declaredTenant.textValue();
            }
            var fields = value.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                if (field.getValue().isTextual()) {
                    if (globalReference(field.getKey(), field.getValue().textValue(), references, ownerTenant)) {
                        return true;
                    }
                    if ("identity_json".equals(field.getKey()) || "payloadJson".equals(field.getKey())
                            && value.path("harnessSessionId").isTextual() && value.path("runtimeSessionId").isTextual()
                            || identity && "resourceHandleJson".equals(field.getKey())) {
                        JsonNode nested = parse(field.getValue().textValue());
                        requireEncoded(nested != null);
                        if (savedJsonReference(nested, references, depth + 1, "identity_json".equals(field.getKey()), ownerTenant)) {
                            return true;
                        }
                    }
                }
                if (savedJsonReference(field.getValue(), references, depth + 1, false, ownerTenant)) {
                    return true;
                }
            }
        } else if (value.isArray()) {
            for (JsonNode item : value) {
                if (savedJsonReference(item, references, depth + 1, false, ownerTenant)) {
                    return true;
                }
            }
        }
        return false;
    }

    private static boolean globalReference(String field, String value, Map<String, Set<String>> references, String ownerTenant) {
        String namespace = referenceNamespace(field);
        return namespace != null && references.getOrDefault(namespace, Set.of()).contains(value)
                && localReferenceMatches(namespace, ownerTenant, references);
    }

    private static boolean localReferenceMatches(String namespace, String ownerTenant, Map<String, Set<String>> references) {
        return !Set.of("session", "sessionKey").contains(namespace) || ownerTenant == null
                || references.getOrDefault("tenant", Set.of()).isEmpty() || references.get("tenant").contains(ownerTenant);
    }

    private static String referenceNamespace(String field) {
        return switch (field) {
            case "session_id", "source_session_id", "target_session_id", "parent_session_id", "root_session_id", "child_session_id", "harness_session_id",
                    "runtime_session_id", "runtime_instance_id", "isolation_key", "sessionId", "harnessSessionId",
                    "runtimeSessionId", "runtimeInstanceId", "parentSessionId", "rootSessionId", "childSessionId" -> "session";
            case "binding_id", "active_binding_id", "bindingId", "runtimeBindingId" -> "binding";
            case "request_key", "runtime_request_key", "requestKey" -> "request";
            case "operation_key", "result_operation_key" -> "operationKey";
            case "resource_key", "evidence_resource_key", "artifact_refs_resource_key", "body_resource_key", "manifest_resource_key", "seal_manifest_resource_key" -> "resourceKey";
            case "retirement_id", "retirementId" -> "retirement";
            case "reservation_id", "csi_reservation_id", "reservationId" -> "reservation";
            case "provision_request_id", "csi_provision_request_id", "provisionRequestId" -> "provision";
            case "execution_call_id", "blocked_execution_call_id", "executionCallId" -> "execution";
            case "execution_call_id_hash" -> "executionHash";
            case "read_id", "readId" -> "resourceRead";
            case "session_scope_key", "scope_key", "sessionScopeKey", "scopeKey" -> "scopedSession";
            case "session_key", "harness_key", "runtime_session_key", "sessionKey", "harnessKey" -> "sessionKey";
            default -> null;
        };
    }

    private static String typedReferenceNamespace(String table, String field) {
        if ("ma_operation".equals(table) && "execution_key".equals(field)) {
            return "operationExecutionHash";
        }
        return typedReferenceNamespace(table, null, field);
    }

    private static String typedReferenceNamespace(String table, Row row, String field) {
        if ("ma_tool_execution".equals(table) && "idempotency_key_hash".equals(field)) {
            return "executionIdempotencyHash";
        }
        if ("ma_read_lease".equals(table) && "lease_id".equals(field)) {
            return "resourceRead";
        }
        if ("ma_operation".equals(table) && row != null && "TOOL_RESULT_PROJECTION".equals(row.text("operation_kind")) && "execution_key".equals(field)) {
            return "executionHash";
        }
        if ("ma_output_capture".equals(table) && "execution_key".equals(field)) {
            return "publicationExecutionHash";
        }
        return referenceNamespace(field);
    }

    record HistoricalOwner(Row binding, Row retirement) {
    }

    static HistoricalOwner readHistoricalOwner(HistoricalScan read, String tenantId, String retirementId) throws SQLException {
        requireEncoded(read != null && !read.imageRead);
        return historicalOwner(read, tenantId, retirementId);
    }

    static HistoricalOwner readForeignOwner(HistoricalScan read, Row carrier) throws SQLException {
        requireEncoded(read != null && read.imageRead && read.frozenReader != null && carrier != null);
        var result = historicalOwner(read, carrier.text("tenant_id"), carrier.text("operation_id"));
        requireEncoded(Arrays.equals(result.retirement().bytes(), carrier.bytes()));
        return result;
    }

    private static HistoricalOwner historicalOwner(HistoricalScan read, String tenantId, String retirementId) throws SQLException {
        requireEncoded(retirementId != null
                && java.util.UUID.fromString(retirementId).toString().equals(retirementId));
        historyRemaining(read.started);
        var retirement = CATALOGUE.stream().filter(table -> table.name().equals("ma_operation")).findFirst().orElseThrow();
        var retirements = read.query(retirement, "operation_key = ? AND operation_kind = 'CSI_RETIREMENT'",
                List.of(new Cell(Kind.CHAR, utf8(WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenantId, retirementId)))));
        requireEncoded(read.blockers.isEmpty() && retirements.size() == 1);
        Row saved = retirements.getFirst();
        var intent = retirement(saved);
        requireEncoded(tenantId.equals(saved.text("tenant_id")) && retirementId.equals(intent.operationId())
                && java.util.UUID.fromString(intent.reservation().bindingId()).toString().equals(intent.reservation().bindingId()));
        var binding = CATALOGUE.stream().filter(table -> table.name().equals("ma_runtime_binding")).findFirst().orElseThrow();
        var bindings = read.query(binding, "binding_id = ?", List.of(new Cell(Kind.VARBINARY, utf8(intent.reservation().bindingId()))));
        requireEncoded(read.blockers.isEmpty() && bindings.size() == 1);
        historyRemaining(read.started);
        return new HistoricalOwner(bindings.getFirst(), saved);
    }

    /** Own keys and strong roots only; never starts a nested carrier scan or changes the parent roots. */
    static void auditForeignOwner(HistoricalScan read, Snapshot expected, JdbcCsiFilesRetirementGuard.Original original,
            WorkspaceCsiReservationStore.Retirement intent) throws SQLException {
        requireEncoded(read != null && read.imageRead && read.frozenReader != null && expected != null);
        expected = restoreCanonical(expected.bytes());
        requireEncoded(expected.blockers().isEmpty()
                && expected.tables().stream().flatMap(table -> table.rows().stream()).noneMatch(row -> row.membership() == Membership.OTHER));
        var ownReferences = originalReferences(original, intent, expected);
        for (Declaration declaration : CATALOGUE) {
            readFixed(read, declaration, expected.table(declaration.name()).rows(), ownReferences);
        }
        requireEncoded(read.blockers.isEmpty());
    }

    static Snapshot readRetainedReferencedKeys(HistoricalScan read, Snapshot expected,
            JdbcCsiFilesRetirementGuard.Original original, WorkspaceCsiReservationStore.Retirement intent) throws SQLException {
        requireEncoded(original != null && original.state() == com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.DRAINING
                && expected != null && expected.table("ma_storage_owner").rows().size() == 1);
        requireEncoded(expected != null && original != null && original.request() != null && original.generation() == 1 && intent != null
                && original.bindingId().equals(WorkspaceCsiApplicationImage.sole(expected, "ma_runtime_binding").text("binding_id")));
        expected = restoreCanonical(expected.bytes());
        var binding = WorkspaceCsiApplicationImage.sole(expected, "ma_runtime_binding");
        requireEncoded(original.request().requestKey().equals(binding.text("request_key"))
                && original.request().getIsolationKey().equals(binding.text("isolation_key"))
                && original.request().getScope().getTenantId().equals(binding.text("tenant_id"))
                && original.request().getScope().getWorkspaceId().equals(binding.text("workspace_id"))
                && Objects.equals(binding.number("runtime_generation"), original.generation())
                && intent.reservation() != null && original.bindingId().equals(intent.reservation().bindingId())
                && Objects.equals(intent.reservation().runtimeGeneration(), original.generation()));
        return scanRetainedImage(read, expected, originalReferences(original, intent, expected));
    }

    static Snapshot scanRetainedImage(HistoricalScan read, Snapshot expected, Map<String, Set<String>> references) throws SQLException {
        requireEncoded(read != null && !read.imageRead && expected != null && references != null);
        expected = restoreCanonical(expected.bytes());
        requireEncoded(expected.blockers().isEmpty() && expected.table("ma_storage_owner").rows().size() == 1
                && expected.table("ma_storage_owner").rows().getFirst().membership() == Membership.ORIGINAL
                && expected.tables().stream().flatMap(table -> table.rows().stream()).noneMatch(row -> row.membership() == Membership.OTHER));
        var pinnedReferences = new LinkedHashMap<String, Set<String>>();
        references.forEach((namespace, values) -> pinnedReferences.put(namespace, Set.copyOf(values)));
        var expectedTenants = expected.table("ma_session").rows().stream().filter(row -> row.membership() == Membership.ORIGINAL)
                .map(row -> row.text("tenant_id")).collect(java.util.stream.Collectors.toUnmodifiableSet());
        if (!references.isEmpty() && !expectedTenants.isEmpty()) {
            pinnedReferences.putIfAbsent("tenant", expectedTenants);
        }
        read.references = Map.copyOf(pinnedReferences);
        read.imageRead = true;
        references = read.references;
        List<Table> tables = new ArrayList<>();
        for (Declaration declaration : CATALOGUE) {
            var wanted = expected.table(declaration.name()).rows();
            Map<String, Row> fixed = new LinkedHashMap<>();
            wanted.forEach(row -> requireEncoded(fixed.put(key(row), row) == null));
            var current = readFixed(read, declaration, wanted, references);
            if (!references.isEmpty()) {
                var carriers = declaration.columns().stream().filter(column -> structured(column.name())
                        || column.kind() == Kind.MEDIUMBLOB || column.kind() == Kind.LONGBLOB
                        || "object_key".equals(column.name()) || "capture_object_key".equals(column.name())).map(column -> column.name() + " IS NOT NULL").toList();
                if (!carriers.isEmpty() || "ma_snapshot".equals(declaration.name())) {
                    var candidates = read.query(declaration, carriers.isEmpty() ? "1 = 1" : String.join(" OR ", carriers), List.of());
                    // Manifests establish coverage before independently fetched byte parts are accepted.
                    if ("ma_resource".equals(declaration.name())) {
                        for (Row row : candidates) {
                            if (!fixed.containsKey(key(row)) && (chunkManifest(row.text("kind"))
                                    || "managed-snapshot-manifest".equals(row.text("kind")))) {
                                read.carrier(declaration.name(), row);
                            }
                        }
                    }
                    for (Row row : candidates) {
                        if (!fixed.containsKey(key(row))) {
                            if (!"ma_resource".equals(declaration.name())
                                    || !chunkManifest(row.text("kind")) && !"managed-snapshot-manifest".equals(row.text("kind"))) {
                                read.carrier(declaration.name(), row);
                            }
                        }
                    }
                }
            }
            tables.add(new Table(declaration.name(), declaration.columns(), declaration.keys(), current));
        }
        historyRemaining(read.started);
        return new Snapshot(tables, read.blockers, read.count, read.bytes);
    }

    private static List<Row> readFixed(HistoricalScan read, Declaration declaration, List<Row> wanted,
            Map<String, Set<String>> references) throws SQLException {
        Map<String, Row> fixed = new LinkedHashMap<>();
        wanted.forEach(row -> requireEncoded(fixed.put(key(row), row) == null));
        List<String> predicates = new ArrayList<>();
        List<Cell> parameters = new ArrayList<>();
        String tuple = "(" + String.join(" AND ", declaration.keys().stream().map(column -> column + " = ?").toList()) + ")";
        for (Row row : wanted) {
            predicates.add(tuple);
            parameters.addAll(row.key());
        }
        for (Column column : declaration.columns()) {
            String namespace = typedReferenceNamespace(declaration.name(), column.name());
            var identities = namespace == null ? Set.<String>of() : references.getOrDefault(namespace, Set.of());
            if (!identities.isEmpty()) {
                String selected = column.name() + " IN (" + String.join(",", Collections.nCopies(identities.size(), "?")) + ")";
                var tenants = references.getOrDefault("tenant", Set.of());
                Column tenantColumn = declaration.columns().stream().filter(field -> field.name().equals("tenant_id"))
                        .findFirst().orElse(null);
                if (Set.of("session", "sessionKey").contains(namespace) && !tenants.isEmpty() && tenantColumn != null) {
                    selected = "(tenant_id IN (" + String.join(",", Collections.nCopies(tenants.size(), "?")) + ") AND " + selected + ")";
                    tenants.stream().sorted().forEach(value -> parameters.add(new Cell(tenantColumn.kind(), utf8(value))));
                }
                predicates.add(selected);
                identities.stream().sorted().forEach(value -> parameters.add(new Cell(column.kind(), utf8(value))));
            }
        }
        List<Row> current = new ArrayList<>();
        for (Row row : read.query(declaration, predicates.isEmpty() ? "1 = 0" : String.join(" OR ", predicates), parameters)) {
            Row pinned = fixed.get(key(row));
            if (pinned == null) {
                read.block(declaration.name(), row, "extra_historical_reference");
                continue;
            }
            Row projected = pinned.membership() == Membership.CONTEXT ? WorkspaceCsiApplicationHistoryImage.context(declaration.name(), row)
                    : row.withMembership(Membership.ORIGINAL);
            current.add(projected);
            if (!Arrays.equals(projected.bytes, pinned.bytes)) {
                read.block(declaration.name(), row, "historical_row_changed");
            }
        }
        current.sort(WorkspaceCsiApplicationInventory::compareKeys);
        if (current.size() != wanted.size()) {
            read.blockers.add(new Blocker(declaration.name(), null, "missing_historical_key"));
        }
        return current;
    }

    private static boolean structured(String field) {
        return field.endsWith("_json") || "artifact_refs".equals(field);
    }

    @FunctionalInterface
    interface FrozenOwnerReader {
        Snapshot read(HistoricalScan scan, Row carrier) throws SQLException;
    }

    static final class HistoricalScan {
        final Connection connection;
        final long started;
        private Map<String, Set<String>> references = Map.of();
        private boolean imageRead;
        private final Map<String, Map<String, Row>> seen = new LinkedHashMap<>();
        private final List<Blocker> blockers = new ArrayList<>();
        private final Set<String> chunkParts = new LinkedHashSet<>();
        private final Set<String> snapshotRoots = new LinkedHashSet<>();
        private final Set<String> snapshotPages = new LinkedHashSet<>();
        private final Set<String> snapshotBodies = new LinkedHashSet<>();
        private final Set<String> snapshotReferences = new LinkedHashSet<>();
        private final Map<String, com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord> nativeMembers = new LinkedHashMap<>();
        private final FrozenOwnerReader frozenReader;
        private int count;
        private long bytes;
        private boolean overflow;

        HistoricalScan(Connection connection, long started) throws SQLException {
            this(connection, started, null);
        }

        HistoricalScan(Connection connection, long started, FrozenOwnerReader frozenReader) throws SQLException {
            requireEncoded(connection != null && !connection.getAutoCommit() && connection.isReadOnly()
                    && connection.getTransactionIsolation() == Connection.TRANSACTION_REPEATABLE_READ);
            historyRemaining(started);
            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.validate(connection);
            historyRemaining(started);
            this.connection = connection;
            this.started = started;
            this.frozenReader = frozenReader;
        }

        private List<Row> query(Declaration declaration, String predicate, List<Cell> parameters) throws SQLException {
            return query(declaration, predicate, parameters, false);
        }

        List<com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord> originalExecutions(JdbcCsiFilesRetirementGuard.Original original)
                throws SQLException {
            requireEncoded(!imageRead);
            return executions(original);
        }

        List<com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord> foreignExecutions(JdbcCsiFilesRetirementGuard.Original original)
                throws SQLException {
            requireEncoded(imageRead && frozenReader != null);
            return executions(original);
        }

        private List<com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord> executions(JdbcCsiFilesRetirementGuard.Original original)
                throws SQLException {
            requireEncoded(original != null && original.request() != null
                    && JdbcCsiFilesRetirementGuard.isProfile(original.request().getScope()));
            var declaration = CATALOGUE.stream().filter(table -> table.name().equals("ma_tool_execution")).findFirst().orElseThrow();
            var current = query(declaration, "binding_id = ? OR harness_session_id = ? OR runtime_session_id = ?",
                    List.of(new Cell(Kind.VARBINARY, utf8(original.bindingId())),
                            new Cell(Kind.VARBINARY, utf8(original.request().getIsolationKey())),
                            new Cell(Kind.VARBINARY, utf8(original.request().getIsolationKey()))), true);
            requireEncoded(blockers.isEmpty());
            return current.stream().map(row -> {
                var member = nativeMembers.get(key(row));
                requireEncoded(member != null);
                return member;
            }).toList();
        }

        private List<Row> query(Declaration declaration, String predicate, List<Cell> parameters, boolean decodeMembers) throws SQLException {
            historyRemaining(started);
            if (overflow) {
                return List.of();
            }
            var result = new ArrayList<Row>();
            String sql = "SELECT t.* FROM " + declaration.name() + " t WHERE " + predicate + " ORDER BY "
                    + String.join(",", declaration.keys()) + " LIMIT " + (MAX_ROWS + 1);
            try (var statement = connection.prepareStatement(sql)) {
                statement.setQueryTimeout(historyRemaining(started));
                statement.setFetchSize("MySQL".equals(connection.getMetaData().getDatabaseProductName()) ? Integer.MIN_VALUE : 1);
                int parameter = 1;
                for (Cell cell : parameters) {
                    historicalParameter(statement, parameter++, cell);
                }
                try (var rows = statement.executeQuery()) {
                    if (!schema(rows.getMetaData(), declaration)) {
                        blockers.add(new Blocker(declaration.name(), null, "schema_drift"));
                        return List.of();
                    }
                    while (rows.next()) {
                        historyRemaining(started);
                        var decoded = decodeRow(rows, declaration);
                        if (decoded.blocker() != null) {
                            blockers.add(new Blocker(declaration.name(), null, decoded.blocker()));
                            overflow = "byte_limit".equals(decoded.blocker());
                            break;
                        }
                        Row row = decoded.row();
                        var table = seen.computeIfAbsent(declaration.name(), ignored -> new LinkedHashMap<>());
                        Row previous = table.get(key(row));
                        if (previous != null) {
                            if (!Arrays.equals(previous.bytes, row.bytes)) {
                                block(declaration.name(), row, "historical_candidate_changed");
                            }
                        } else {
                            if (count == MAX_ROWS || bytes + row.bytes.length > MAX_BYTES) {
                                block(declaration.name(), row, count == MAX_ROWS ? "row_limit" : "byte_limit");
                                overflow = true;
                                break;
                            }
                            count++;
                            bytes += row.bytes.length;
                            table.put(key(row), row);
                        }
                        if (decodeMembers && !nativeMembers.containsKey(key(row))) {
                            try {
                                nativeMembers.put(key(row), com.alibaba.qwen.code.runtimebroker.JdbcCsiExecutionAdmission.readHistoricalMember(rows));
                            } catch (RuntimeException malformed) {
                                block(declaration.name(), row, "invalid_historical_execution");
                            }
                        }
                        result.add(row);
                    }
                }
            } catch (SQLException unavailable) {
                blockers.add(new Blocker(declaration.name(), null, "query_unavailable"));
            }
            return result;
        }

        private void block(String table, Row row, String code) {
            blockers.add(new Blocker(table, key(row), code));
        }

        private void carrier(String table, Row row) throws SQLException {
            historyRemaining(started);
            try {
                if (savedOriginalReference(table, row, references)) {
                    block(table, row, "extra_historical_reference");
                    return;
                }
                if ("ma_snapshot".equals(table)) {
                    if (!snapshotRoots.contains(key(row))) {
                        Row manifest = one("ma_resource", "resource_key = ?",
                                List.of(new Cell(Kind.CHAR, utf8(row.text("manifest_resource_key")))));
                        requireEncoded("managed-snapshot-manifest".equals(manifest.text("kind")));
                        snapshot(manifest);
                        requireEncoded(snapshotRoots.contains(key(row)));
                    }
                } else if ("ma_operation".equals(table) && "CSI_RETIREMENT".equals(row.text("operation_kind"))) {
                    if (frozenReader == null) {
                        block(table, row, "unsupported_historical_payload");
                        return;
                    }
                    var baseline = frozenReader.read(this, row);
                    for (Table saved : baseline.tables()) {
                        for (Row value : saved.rows()) {
                            if (value.membership() == Membership.ORIGINAL && savedOriginalReference(saved.name(), value, references)) {
                                block(table, row, "extra_historical_reference");
                            }
                        }
                    }
                    JsonNode envelope = WorkspaceCsiApplicationJson.object(row.binary("frozen_request_bytes"), MAX_BYTES);
                    JsonNode body = WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.base64(
                            envelope.path("commitBodyBase64"), 128 * 1024), 128 * 1024);
                    var active = new ArrayList<JsonNode>(List.of(envelope, body,
                            WorkspaceCsiApplicationJson.object(WorkspaceCsiApplicationJson.base64(
                                    envelope.path("preCutObservationBase64"), com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol.RESPONSE_LIMIT),
                                    com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol.RESPONSE_LIMIT)));
                    active.addAll(CsiNativeActivationProof.records(WorkspaceCsiApplicationJson.base64(body.path("recordBytesBase64"), 128 * 1024)));
                    for (String field : List.of("cut_bytes", "finalize_receipt_bytes")) {
                        if (row.binary(field) != null) {
                            active.add(WorkspaceCsiApplicationJson.object(row.binary(field), MAX_BYTES));
                        }
                    }
                    if (active.stream().anyMatch(value -> savedJsonReference(value, references, 0, false))) {
                        block(table, row, "extra_historical_reference");
                    }
                } else if ("ma_session_journal_tx".equals(table)) {
                    byte[] raw = payload(row, "record_bytes", "record_digest", 8 * 1024 * 1024);
                    requireEncoded("identity".equals(row.text("record_encoding")));
                    var records = CsiNativeActivationProof.records(raw);
                    for (JsonNode record : records) {
                        requireEncoded(row.text("session_id").equals(record.path("sessionId").textValue()));
                        if (savedJsonReference(record, references, 0, false)) {
                            block(table, row, "extra_historical_reference");
                        }
                    }
                } else if ("ma_resource".equals(table)) {
                    if (row.text("publication_id") != null) {
                        publicationObject(row);
                    } else {
                        nativeResource(row);
                    }
                } else if (row.fields().values().stream().anyMatch(cell -> !cell.isNull()
                        && (cell.kind() == Kind.MEDIUMBLOB || cell.kind() == Kind.LONGBLOB))
                        || row.text("object_key") != null) {
                    block(table, row, "unsupported_historical_payload");
                }
            } catch (RuntimeException malformed) {
                block(table, row, "invalid_historical_payload");
            }
            historyRemaining(started);
        }

        private void nativeResource(Row row) throws SQLException {
            resourceMetadata(row);
            String kind = row.text("kind");
            if (Set.of("managed-agent-instructions", "managed-agent-skills").contains(kind)) {
                agentResource(row);
                return;
            }
            if ("managed-snapshot-manifest".equals(kind)) {
                snapshot(row);
                return;
            }
            if ("managed-snapshot-page".equals(kind)) {
                requireEncoded(snapshotPages.contains(key(row)));
                return;
            }
            byte[] raw = payload(row, "inline_bytes", "sha256",
                    "managed-message-parts".equals(kind) ? MAX_BYTES : 8 * 1024 * 1024);
            if (chunkPart(kind)) {
                requireEncoded(chunkParts.contains(key(row)));
                return;
            }
            JsonNode value;
            if ("managed-message-parts".equals(kind)) {
                value = projectedMessageParts(row, raw);
            } else if (chunkManifest(kind)) {
                Set<String> consumed = new LinkedHashSet<>();
                value = chunkBody(row, ref -> {
                    historyRemaining(started);
                    return chunkMember(row, ref, seen.getOrDefault("ma_resource", Map.of()).values());
                }, consumed);
                chunkParts.addAll(consumed);
            } else if ("managed-message".equals(kind)) {
                value = CsiNativeActivationProof.messageBody(resourceRef(row), ignored -> raw);
            } else if ("managed-tool-outcome".equals(kind)) {
                value = CsiNativeActivationProof.toolOutcomeBody(resourceRef(row), ignored -> raw);
            } else if ("managed-input".equals(kind)) {
                value = CsiNativeActivationProof.inputBlocks(raw);
            } else if (Set.of("managed-activation-boundary", "managed-activation-install", "managed-admission",
                    "managed-checkpoint", "managed-definition", "managed-file_history", "managed-hosted-model-route",
                    "managed-hosted-model-usage", "managed-root",
                    "managed-tool-definition", "managed-tool-input", "managed-turn-result").contains(kind)) {
                value = CsiNativeActivationProof.readObject(raw);
            } else {
                block("ma_resource", row, "unsupported_historical_payload");
                return;
            }
            if (savedJsonReference(value, references, 0, false)) {
                block("ma_resource", row, "extra_historical_reference");
            }
        }

        private static void resourceMetadata(Row row) {
            requireEncoded(ManagedSessionStore.sessionScopeKey(row.text("tenant_id"), row.text("session_id"))
                    .equals(row.text("session_scope_key"))
                    && ManagedSessionStore.resourceKey(row.text("session_scope_key"), row.text("resource_id")).equals(row.text("resource_key"))
                    && Objects.equals(row.number("schema_version"), 1L)
                    && "MYSQL_INLINE".equals(row.text("storage_kind")) && row.text("object_key") == null
                    && row.text("object_version_id") == null && row.text("encryption_key_id") == null
                    && Set.of("PUBLISHED", "REFERENCED").contains(row.text("state")));
        }

        private Row one(String table, String predicate, List<Cell> parameters) throws SQLException {
            var rows = query(CATALOGUE.stream().filter(value -> value.name().equals(table)).findFirst().orElseThrow(), predicate, parameters);
            requireEncoded(rows.size() == 1);
            return rows.getFirst();
        }

        private List<Row> resourceReferences(Row row) throws SQLException {
            return query(CATALOGUE.stream().filter(value -> value.name().equals("ma_resource_ref")).findFirst().orElseThrow(),
                    "resource_key = ?", List.of(new Cell(Kind.CHAR, utf8(row.text("resource_key")))));
        }

        private void foreignArtifact(String table, Row row, JsonNode value) {
            if (savedOriginalReference(table, row, references)
                    || value != null && savedJsonReference(value, references, 0, false, row.text("tenant_id"))) {
                block(table, row, "extra_historical_reference");
                throw new IllegalArgumentException("Artifact references the original owner");
            }
        }

        private static void absent(Row row, String... fields) {
            for (String field : fields) {
                requireEncoded(row.cell(field).isNull());
            }
        }

        private static void publicResource(Row row) {
            resourceMetadata(row);
            requireEncoded("REFERENCED".equals(row.text("state")));
            absent(row, "workspace_id", "publish_command_id", "scope_key", "publication_id", "slot_key", "capture_state",
                    "capture_object_key", "operation_id", "quarantine_reason", "deletion_operation_key");
        }

        private static JsonNode publicJson(byte[] bytes) {
            try {
                JsonNode value = PUBLIC_ARTIFACTS.readTree(strictText(bytes));
                requireEncoded(value != null);
                return value;
            } catch (IOException malformed) {
                throw new IllegalArgumentException("Invalid public artifact JSON", malformed);
            }
        }

        private static long integer(JsonNode value, String field) {
            JsonNode number = value.path(field);
            requireEncoded(number.isIntegralNumber() && number.canConvertToLong());
            return number.longValue();
        }

        private void agentResource(Row row) {
            boolean instructions = "managed-agent-instructions".equals(row.text("kind"));
            byte[] raw = row.binary("inline_bytes");
            requireEncoded(raw != null && raw.length <= (instructions ? ManagedSessionStoreModels.MAX_AGENT_INSTRUCTIONS_BYTES
                    : ManagedSessionStoreModels.MAX_AGENT_SKILLS_BYTES)
                    && Objects.equals(row.number("byte_length"), (long) raw.length) && hash(raw).equals(row.text("sha256"))
                    && ((instructions ? "agent-instructions-" : "agent-skills-") + hash(raw)).equals(row.text("resource_id"))
                    && row.text("resource_id").equals(row.text("publish_command_id"))
                    && row.text("workspace_id") != null && !row.text("workspace_id").isEmpty());
            absent(row, "snapshot_id", "snapshot_page_ordinal", "snapshot_page_first_sequence", "snapshot_page_last_sequence",
                    "scope_key", "publication_id", "slot_key", "capture_state", "capture_object_key", "operation_id",
                    "quarantine_reason", "deletion_operation_key");
            try {
                strictText(raw);
                if (!instructions) {
                    JsonNode skills = publicJson(raw);
                    requireEncoded(skills.isArray());
                    AgentDefinitionExtensions.skills(PUBLIC_ARTIFACTS.convertValue(skills, Object.class), true);
                }
            } catch (IOException malformed) {
                throw new IllegalArgumentException("Invalid agent instructions", malformed);
            }
        }

        private void snapshot(Row manifestRow) throws SQLException {
            publicResource(manifestRow);
            absent(manifestRow, "snapshot_id", "snapshot_page_ordinal", "snapshot_page_first_sequence", "snapshot_page_last_sequence");
            byte[] raw = payload(manifestRow, "inline_bytes", "sha256", MAX_BYTES);
            JsonNode value = publicJson(raw);
            WorkspaceCsiApplicationJson.closed(value, Set.of("version", "snapshot", "sequence", "projection", "items", "pages", "cursorSecret"));
            requireEncoded(integer(value, "version") == 1 && integer(value, "sequence") >= 0
                    && integer(value, "projection") > 0 && integer(value, "projection") <= Integer.MAX_VALUE
                    && integer(value, "items") >= 0 && integer(value, "items") <= MAX_ROWS * 100L
                    && integer(value, "pages") >= 0 && integer(value, "pages") <= MAX_ROWS
                    && value.path("snapshot").isTextual() && value.path("cursorSecret").isTextual());
            ManagedSnapshotStore.Manifest manifest;
            try {
                manifest = ManagedSnapshotStore.decodeManifest(PUBLIC_ARTIFACTS, raw);
            } catch (IOException malformed) {
                throw new IllegalArgumentException("Invalid snapshot manifest", malformed);
            }
            requireEncoded(java.util.UUID.fromString(manifest.snapshot()).toString().equals(manifest.snapshot())
                    && ("snapshot:" + manifest.snapshot() + ":manifest").equals(manifestRow.text("resource_id")));
            byte[] secret = Base64.getDecoder().decode(manifest.cursorSecret());
            requireEncoded(secret.length == 32 && Base64.getEncoder().encodeToString(secret).equals(manifest.cursorSecret()));
            Row root = one("ma_snapshot", "tenant_id = ? AND session_id = ? AND snapshot_id = ?",
                    List.of(new Cell(Kind.VARBINARY, utf8(manifestRow.text("tenant_id"))),
                            new Cell(Kind.VARBINARY, utf8(manifestRow.text("session_id"))), new Cell(Kind.VARBINARY, utf8(manifest.snapshot()))));
            requireEncoded("PUBLISHED".equals(root.text("state")) && root.number("snapshot_version") > 0
                    && Objects.equals(root.number("covered_sequence"), manifest.sequence())
                    && Objects.equals(root.number("projection_version"), (long) manifest.projection())
                    && Objects.equals(root.number("item_count"), (long) manifest.items())
                    && manifestRow.text("resource_key").equals(root.text("manifest_resource_key"))
                    && manifestRow.text("sha256").equals(root.text("manifest_sha256")) && root.number("published_at") != null);
            foreignArtifact("ma_snapshot", root, null);
            foreignArtifact("ma_resource", manifestRow, value);
            if (snapshotRoots.contains(key(root))) {
                return;
            }
            String scope = manifestRow.text("session_scope_key");
            var resources = new LinkedHashMap<String, Row>();
            resources.put(manifestRow.text("resource_key"), manifestRow);
            var bodies = new LinkedHashSet<String>();
            var pages = query(CATALOGUE.stream().filter(table -> table.name().equals("ma_resource")).findFirst().orElseThrow(),
                    "session_scope_key = ? AND snapshot_id = ?",
                    List.of(new Cell(Kind.CHAR, utf8(scope)), new Cell(Kind.VARBINARY, utf8(manifest.snapshot()))));
            requireEncoded(pages.size() == manifest.pages());
            pages.sort(java.util.Comparator.comparing(row -> row.number("snapshot_page_ordinal")));
            var ids = new LinkedHashSet<String>();
            StoreModels.ItemRecord previous = null;
            for (int ordinal = 0; ordinal < pages.size(); ordinal++) {
                historyRemaining(started);
                Row page = pages.get(ordinal);
                publicResource(page);
                requireEncoded("managed-snapshot-page".equals(page.text("kind")) && sameScope(manifestRow, page)
                        && ("snapshot:" + manifest.snapshot() + ":page:" + ordinal).equals(page.text("resource_id"))
                        && Objects.equals(page.number("snapshot_page_ordinal"), (long) ordinal));
                byte[] bytes = payload(page, "inline_bytes", "sha256", MAX_BYTES);
                JsonNode entries = publicJson(bytes);
                requireEncoded(entries.isArray() && !entries.isEmpty() && entries.size() <= 100);
                for (JsonNode entry : entries) {
                    WorkspaceCsiApplicationJson.closed(entry, Set.of("item", "body"));
                    validateItem(entry.path("item"), manifestRow, manifest.sequence());
                    requireEncoded(entry.path("body").isNull() || entry.path("body").isTextual());
                }
                List<ManagedSnapshotStore.SnapshotItem> frozen;
                try {
                    frozen = ManagedSnapshotStore.decodePage(PUBLIC_ARTIFACTS, bytes);
                } catch (IOException malformed) {
                    throw new IllegalArgumentException("Invalid snapshot page", malformed);
                }
                requireEncoded(Objects.equals(page.number("snapshot_page_first_sequence"), frozen.getFirst().item().firstSequence())
                        && Objects.equals(page.number("snapshot_page_last_sequence"), frozen.getLast().item().firstSequence()));
                for (var entry : frozen) {
                    var item = entry.item();
                    requireEncoded(ids.add(item.itemId()) && (previous == null || previous.firstSequence() < item.firstSequence()
                            || previous.firstSequence() == item.firstSequence()
                            && Arrays.compareUnsigned(utf8(previous.itemId()), utf8(item.itemId())) < 0));
                    previous = item;
                    if (entry.body() != null) {
                        requireEncoded(item.content().isEmpty() && !references.getOrDefault("resourceKey", Set.of()).contains(entry.body()));
                        Row body = one("ma_resource", "resource_key = ?", List.of(new Cell(Kind.CHAR, utf8(entry.body()))));
                        requireEncoded("managed-message-parts".equals(body.text("kind")) && sameScope(manifestRow, body));
                        JsonNode parts = bodyParts(body, payload(body, "inline_bytes", "sha256", MAX_BYTES));
                        bodyRevision(body, item.itemId(), item.revision());
                        partCoverage(parts, item.firstSequence(), item.lastSequence(), item.createdAt(), item.updatedAt());
                        foreignArtifact("ma_resource", body, parts);
                        resources.put(body.text("resource_key"), body);
                        bodies.add(key(body));
                    }
                }
                foreignArtifact("ma_resource", page, entries);
                resources.put(page.text("resource_key"), page);
            }
            requireEncoded(ids.size() == manifest.items());
            String owner = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(scope, manifest.snapshot());
            var refs = query(CATALOGUE.stream().filter(table -> table.name().equals("ma_resource_ref")).findFirst().orElseThrow(),
                    "session_scope_key = ? AND owner_kind = 'SNAPSHOT' AND owner_key = ?",
                    List.of(new Cell(Kind.CHAR, utf8(scope)), new Cell(Kind.CHAR, utf8(owner))));
            var referenced = new LinkedHashSet<String>();
            for (Row ref : refs) {
                Row resource = resources.get(ref.text("resource_key"));
                requireEncoded(resource != null && referenced.add(ref.text("resource_key"))
                        && Objects.equals(ref.number("owner_revision"), root.number("snapshot_version")));
                referenceScope(resource, ref);
                foreignArtifact("ma_resource_ref", ref, null);
                if (!bodies.contains(key(resource))) {
                    var all = resourceReferences(resource);
                    requireEncoded(all.size() == 1 && Arrays.equals(all.getFirst().bytes(), ref.bytes()));
                }
            }
            requireEncoded(referenced.equals(resources.keySet()));
            snapshotRoots.add(key(root));
            pages.forEach(page -> snapshotPages.add(key(page)));
            snapshotBodies.addAll(bodies);
            refs.forEach(ref -> snapshotReferences.add(key(ref)));
        }

        private static boolean sameScope(Row left, Row right) {
            return Objects.equals(left.text("tenant_id"), right.text("tenant_id"))
                    && Objects.equals(left.text("session_id"), right.text("session_id"))
                    && Objects.equals(left.text("session_scope_key"), right.text("session_scope_key"));
        }

        private static void referenceScope(Row resource, Row ref) {
            requireEncoded(sameScope(resource, ref) && Objects.equals(resource.text("resource_id"), ref.text("resource_id")));
            absent(ref, "workspace_id", "journal_revision");
        }

        private static void validateItem(JsonNode item, Row manifest, long sequence) {
            WorkspaceCsiApplicationJson.closed(item, Set.of("tenantId", "sessionId", "itemId", "turnId", "type", "role", "status",
                    "attributes", "firstSequence", "lastSequence", "createdAt", "updatedAt", "revision", "content"));
            requireEncoded(item.path("tenantId").isTextual() && manifest.text("tenant_id").equals(item.path("tenantId").textValue())
                    && item.path("sessionId").isTextual() && manifest.text("session_id").equals(item.path("sessionId").textValue())
                    && item.path("itemId").isTextual() && !item.path("itemId").textValue().isEmpty()
                    && StandardCharsets.UTF_8.newEncoder().canEncode(item.path("itemId").textValue())
                    && item.path("type").isTextual() && !item.path("type").textValue().isEmpty()
                    && (item.path("attributes").isNull() || item.path("attributes").isObject()));
            for (String field : List.of("turnId", "role", "status")) {
                requireEncoded(item.path(field).isNull() || item.path(field).isTextual());
            }
            long first = integer(item, "firstSequence"), last = integer(item, "lastSequence");
            long created = integer(item, "createdAt"), updated = integer(item, "updatedAt");
            requireEncoded(first >= 0 && last >= first && last <= sequence && created >= 0 && updated >= created && integer(item, "revision") > 0);
            JsonNode parts = item.path("content");
            validateParts(parts);
            partCoverage(parts, first, last, created, updated);
        }

        private static JsonNode bodyParts(Row row, byte[] raw) {
            publicResource(row);
            absent(row, "snapshot_id", "snapshot_page_ordinal", "snapshot_page_first_sequence", "snapshot_page_last_sequence");
            requireEncoded(raw.length > 64 * 1024);
            JsonNode parts = publicJson(raw);
            validateParts(parts);
            return parts;
        }

        private static void validateParts(JsonNode parts) {
            requireEncoded(parts.isArray());
            var ids = new LinkedHashSet<String>();
            for (JsonNode part : parts) {
                WorkspaceCsiApplicationJson.closed(part, Set.of("partId", "type", "text", "firstSequence", "lastSequence",
                        "createdAt", "updatedAt", "revision"));
                requireEncoded(part.path("partId").isTextual() && !part.path("partId").textValue().isEmpty()
                        && ids.add(part.path("partId").textValue()) && part.path("type").isTextual()
                        && !part.path("type").textValue().isEmpty() && part.path("text").isTextual());
                long first = integer(part, "firstSequence"), last = integer(part, "lastSequence");
                long created = integer(part, "createdAt"), updated = integer(part, "updatedAt");
                requireEncoded(first >= 0 && last >= first && created >= 0 && updated >= created && integer(part, "revision") > 0);
            }
        }

        private static void partCoverage(JsonNode parts, long first, long last, long created, long updated) {
            for (JsonNode part : parts) {
                requireEncoded(integer(part, "firstSequence") >= first && integer(part, "lastSequence") <= last
                        && integer(part, "createdAt") >= created && integer(part, "updatedAt") <= updated);
            }
        }

        private static long bodyRevision(Row body, String item, long revision) {
            String[] id = body.text("resource_id").split(":", -1);
            requireEncoded(id.length == 4 && "message".equals(id[0])
                    && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(body.text("session_scope_key"), item).equals(id[1])
                    && id[2].matches("[1-9][0-9]{0,18}") && body.text("sha256").equals(id[3]));
            long original = Long.parseLong(id[2]);
            requireEncoded(original > 0 && original <= revision);
            return original;
        }

        private JsonNode projectedMessageParts(Row row, byte[] raw) {
            JsonNode parts = bodyParts(row, raw);
            try {
                var messages = query(CATALOGUE.stream().filter(table -> table.name().equals("ma_message")).findFirst().orElseThrow(),
                        "body_resource_key = ?", List.of(new Cell(Kind.CHAR, utf8(row.text("resource_key")))));
                requireEncoded(messages.size() <= 1 && (!messages.isEmpty() || snapshotBodies.contains(key(row))));
                long revision = 0;
                String owner = null;
                if (!messages.isEmpty()) {
                    Row message = messages.getFirst();
                    requireEncoded(Objects.equals(row.text("tenant_id"), message.text("tenant_id"))
                            && Objects.equals(row.text("session_id"), message.text("session_id")) && "[]".equals(message.text("parts_json")));
                    revision = bodyRevision(row, message.text("item_id"), message.number("revision"));
                    owner = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(row.text("session_scope_key"), message.text("item_id"));
                    partCoverage(parts, message.number("first_sequence"), message.number("last_sequence"),
                            message.number("gmt_create"), message.number("gmt_modified"));
                }
                int current = 0;
                for (Row ref : resourceReferences(row)) {
                    referenceScope(row, ref);
                    foreignArtifact("ma_resource_ref", ref, null);
                    if ("MESSAGE".equals(ref.text("owner_kind"))) {
                        requireEncoded(owner != null && owner.equals(ref.text("owner_key")) && Objects.equals(ref.number("owner_revision"), revision));
                        current++;
                    } else {
                        requireEncoded("SNAPSHOT".equals(ref.text("owner_kind")) && snapshotReferences.contains(key(ref)));
                    }
                }
                requireEncoded(current == messages.size());
                return parts;
            } catch (SQLException unavailable) {
                throw new IllegalArgumentException("Message projection ownership unavailable", unavailable);
            }
        }

        private static JsonNode resourceRef(Row row) {
            return JSON.createObjectNode().put("resourceId", row.text("resource_id")).put("kind", row.text("kind"))
                    .put("schemaVersion", row.number("schema_version")).put("byteLength", row.number("byte_length"))
                    .put("digest", row.text("sha256"));
        }

        private void publicationObject(Row row) {
            var owners = seen.getOrDefault("ma_output_capture", Map.of()).values().stream()
                    .filter(owner -> Objects.equals(row.text("scope_key"), owner.text("scope_key"))
                            && Objects.equals(row.text("publication_id"), owner.text("publication_id"))).toList();
            requireEncoded(owners.size() == 1);
            Row owner = owners.getFirst();
            requireEncoded(ToolPublicationDataStore.scope(owner.text("tenant_id"), owner.text("workspace_id"), owner.text("session_id"))
                    .equals(row.text("scope_key")));
            JsonNode binding = ToolPublicationContract.parseBytes("binding", owner.binary("binding_json"));
            requireEncoded(ToolPublicationContract.bindingDigest(binding).equals(owner.text("binding_digest"))
                    && hash(utf8(binding.path("executionCallId").textValue())).equals(owner.text("execution_key"))
                    && row.text("publication_id").equals(binding.path("publicationId").textValue())
                    && owner.text("tenant_id").equals(binding.path("sessionKey").path("tenantId").textValue())
                    && owner.text("workspace_id").equals(binding.path("sessionKey").path("workspaceId").textValue())
                    && owner.text("session_id").equals(binding.path("sessionKey").path("sessionId").textValue()));
            requireEncoded(Objects.equals(owner.text("tenant_id"), row.text("tenant_id"))
                    && Objects.equals(owner.text("workspace_id"), row.text("workspace_id"))
                    && Objects.equals(owner.text("session_id"), row.text("session_id"))
                    && ManagedSessionStore.sessionScopeKey(row.text("tenant_id"), row.text("session_id"))
                            .equals(row.text("session_scope_key"))
                    && ManagedSessionStore.resourceKey(row.text("session_scope_key"), row.text("resource_id"))
                            .equals(row.text("resource_key"))
                    && Objects.equals(1L, row.number("schema_version"))
                    && row.cell("object_key").isNull() && row.cell("object_version_id").isNull()
                    && row.cell("encryption_key_id").isNull()
                    && (row.text("capture_object_key") == null ? "MYSQL_INLINE" : "TOOL_PUBLICATION")
                            .equals(row.text("storage_kind")));
            String kind = row.text("kind");
            String slot = row.text("slot_key");
            boolean opaque = "managed-tool-segment".equals(kind) && slot.matches("segment:(stdout|stderr):(?:0|[1-9][0-9]{0,4})")
                    || "managed-tool-result-content".equals(kind) && slot.matches("content:[a-z0-9_-]{1,128}");
            if (opaque && "managed-tool-segment".equals(kind)) {
                requireEncoded(Integer.parseInt(slot.substring(slot.lastIndexOf(':') + 1)) < 65536);
            }
            requireEncoded(row.number("byte_length") != null && row.number("byte_length") >= 0
                    && row.number("byte_length") <= 16 * 1024 * 1024 && row.text("sha256") != null
                    && row.text("sha256").matches("[0-9a-f]{64}")
                    && Objects.equals(row.text("resource_id"), "managed-tool-segment".equals(kind)
                            ? "capture-segment-" + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(
                                    row.text("scope_key"), row.text("publication_id"), slot) : "result-"
                            + hash(utf8(row.text("scope_key") + ":" + row.text("publication_id") + ":" + slot)).substring(0, 32)));
            if (row.text("capture_object_key") != null) {
                requireEncoded(row.binary("inline_bytes") == null && row.text("capture_object_key").equals("managed-tool-results/"
                        + row.text("scope_key") + "/" + row.text("publication_id") + "/" + hash(utf8(slot))));
                if (!opaque) {
                    block("ma_resource", row, "unsupported_historical_payload");
                }
                return;
            }
            byte[] raw = row.binary("inline_bytes");
            requireEncoded(raw != null && Objects.equals(row.number("byte_length"), (long) raw.length)
                    && hash(raw).equals(row.text("sha256")));
            if (opaque) {
                return;
            }
            JsonNode value;
            if ("managed-tool-result-page".equals(kind) && slot.matches("page:(stdout|stderr):(?:0|[1-9][0-9]{0,4})")) {
                value = ToolPublicationContract.parseToolResult("page", raw, 256 * 1024);
                requireEncoded(slot.equals("page:" + value.path("streamId").textValue() + ":" + value.path("firstOrdinal").longValue()));
            } else if ("managed-tool-result-manifest".equals(kind) && "manifest:1".equals(slot)) {
                value = ToolPublicationContract.parseToolResult("manifest", raw, 64 * 1024);
                requireEncoded(value.path("revision").longValue() == 1);
            } else if ("managed-tool-terminal".equals(kind) && "terminal".equals(slot)) {
                value = ToolPublicationContract.parseToolResult("result", raw, 2 * 1024 * 1024);
            } else if ("managed-tool-outcome".equals(kind) && "admission".equals(slot)) {
                value = WorkspaceCsiApplicationJson.object(raw, 2 * 1024 * 1024);
                WorkspaceCsiApplicationJson.closed(value, Set.of("schemaVersion", "decision", "envelope", "history", "manifestRef"));
                requireEncoded(value.path("schemaVersion").isIntegralNumber() && value.path("schemaVersion").longValue() == 1
                        && ToolPublicationDataStore.validAdmissionHistory(value.path("history")));
                JsonNode envelope = ToolPublicationContract.parseToolResult("result", WorkspaceCsiApplicationJson.encode(value.path("envelope")), 2 * 1024 * 1024);
                requireEncoded(value.path("manifestRef").equals(envelope.path("capture").path("manifest"))
                        && ("complete".equals(envelope.path("capture").path("captureStatus").textValue()) ? "committed" : "blocked")
                                .equals(value.path("decision").textValue()));
            } else {
                block("ma_resource", row, "unsupported_historical_payload");
                return;
            }
            if (savedJsonReference(value, references, 0, false)) {
                block("ma_resource", row, "extra_historical_reference");
            }
        }

        private static byte[] payload(Row row, String field, String digest, int limit) {
            byte[] raw = row.binary(field);
            requireEncoded(raw != null && raw.length > 0 && raw.length <= limit
                    && Objects.equals(row.number("byte_length"), (long) raw.length) && hash(raw).equals(row.text(digest)));
            return raw;
        }
    }

    private static int historyRemaining(long started) {
        long left = TimeUnit.SECONDS.toNanos(10) - (System.nanoTime() - started);
        requireEncoded(left > 0);
        return (int) Math.max(1, TimeUnit.NANOSECONDS.toSeconds(left));
    }

    private static void historicalParameter(PreparedStatement statement, int index, Cell cell) throws SQLException {
        requireEncoded(!cell.isNull());
        if (cell.kind().binary()) {
            statement.setBytes(index, cell.bytes());
        } else if (cell.kind().integral()) {
            statement.setLong(index, cell.number());
        } else if (cell.kind() == Kind.BOOLEAN) {
            statement.setBoolean(index, cell.bool());
        } else if (cell.kind() == Kind.DATETIME || cell.kind() == Kind.TIMESTAMP) {
            statement.setTimestamp(index, java.sql.Timestamp.from(Instant.parse(cell.text())),
                    Calendar.getInstance(TimeZone.getTimeZone("UTC")));
        } else {
            statement.setString(index, cell.text());
        }
    }

    static Snapshot restoreCanonical(byte[] bytes) {
        if (bytes == null || bytes.length == 0 || bytes.length > MAX_BYTES) {
            throw new IllegalArgumentException("Invalid persisted CSI inventory");
        }
        try (var input = new DataInputStream(new ByteArrayInputStream(bytes))) {
            requireEncoded("qwen-csi-application-inventory/2".equals(readText(input))
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
                if (value != null && column.kind() == Kind.VARBINARY && IDENTITY_FIELDS.contains(column.name())) {
                    strictText(value);
                }
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

    private record DecodedRow(Row row, String blocker) {
    }

    private static DecodedRow decodeRow(ResultSet result, Declaration declaration) throws SQLException {
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
                        return new DecodedRow(null, "invalid_boolean");
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
                                    return new DecodedRow(null, "byte_limit");
                                }
                                text.append(part, 0, count);
                            }
                            bytes = utf8(text.toString());
                        }
                    }
                }
                total += bytes == null ? 0 : bytes.length;
                if (total > MAX_BYTES) {
                    return new DecodedRow(null, "byte_limit");
                }
                fields.put(column.name(), new Cell(column.kind(), bytes));
            }
        } catch (IOException exception) {
            return new DecodedRow(null, "row_bytes_unavailable");
        }
        List<Cell> key = declaration.keys().stream().map(fields::get).toList();
        if (key.stream().anyMatch(value -> value == null || value.isNull())) {
            return new DecodedRow(null, "invalid_primary_key");
        }
        byte[] bytes = encode(out -> {
            out.writeInt(fields.size());
            for (var entry : fields.entrySet()) {
                write(out, entry.getKey());
                write(out, entry.getValue().kind.name());
                write(out, entry.getValue().bytes);
            }
        });
        return new DecodedRow(new Row(key, fields, bytes, Membership.ORIGINAL), null);
    }

    private static boolean schema(ResultSetMetaData metadata, Declaration declaration) throws SQLException {
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
            id("operationKeys", WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, tenant, intent.operationId()));
            seed("runtime_session_id", session);
            seed("runtime_session_id", intent.runtimeInstanceId());
            id("A", intent.reservation().registrationKey());
            id("F", intent.physicalKey());
            id("J", ManagedSessionStore.sessionScopeKey(tenant, session));
            id("M", digest(tenant, session));
            try {
                id("U", hash(JSON.writeValueAsBytes(List.of(tenant, workspace, session))));
            } catch (IOException exception) {
                throw new IllegalArgumentException("Original publication scope cannot be encoded", exception);
            }
            id("RT", ToolPublicationRetentionStore.hash(tenant));
            id("RS", ToolPublicationRetentionStore.hash(session));
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
                int before = ids.values().stream().mapToInt(Set::size).sum();
                expandNativeChunks();
                changed |= before != ids.values().stream().mapToInt(Set::size).sum();
            } while (changed);
        }

        private void scan(Declaration declaration) throws SQLException {
            Query query = predicate(declaration.name());
            String sql = "SELECT t.* FROM " + declaration.name() + " t WHERE (" + query.sql() + ") ORDER BY "
                    + String.join(",", declaration.keys()) + " LIMIT " + (MAX_ROWS + 1) + " FOR UPDATE";
            try (var statement = connection.prepareStatement(sql)) {
                statement.setQueryTimeout(10);
                for (int index = 0; index < query.arguments().size(); index++) {
                    historicalParameter(statement, index + 1, query.arguments().get(index));
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
            DecodedRow decoded = decodeRow(result, declaration);
            if (decoded.blocker() != null) {
                overflow |= "byte_limit".equals(decoded.blocker());
                block(declaration.name(), null, decoded.blocker());
            }
            return decoded.row();
        }

        private Query predicate(String table) {
            return switch (table) {
                case "ma_session" -> query(table, "tenant_id=T&session_id=sessions", "runtime_request_key=requests",
                        "tenant_id=T&parent_session_id=sessions", "tenant_id=T&root_session_id=sessions");
                case "ma_session_head" -> query(table, "tenant_key=BT&harness_key=BS", "tenant_id=T&session_id=sessions");
                case "ma_public_event", "ma_turn", "ma_session_record" ->
                        query(table, "tenant_id=T&session_id=sessions");
                case "ma_event_stream" -> query(table, "tenant_id=T&session_id=sessions", "artifact_refs_resource_key=resourceKeys");
                case "ma_message" -> query(table, "tenant_id=T&session_id=sessions", "body_resource_key=resourceKeys");
                case "ma_snapshot" -> query(table, "tenant_id=T&session_id=sessions", "manifest_resource_key=resourceKeys");
                case "ma_agent_definition" -> query(table, "tenant_id=T&agent_id=agent&revision=agentRevision");
                case "ma_workspace_access", "ma_channel_instance" -> query(table, "tenant_id=T&workspace_id=W");
                case "ma_workspace" -> query(table, "tenant_id=T&workspace_id=W", "tenant_id=T&storage_id=D",
                        "tenant_id=T&parent_session_id=sessions");
                case "ma_storage" -> query(table, "alias_key=A", "physical_key=F", "tenant_id=T&storage_id=D");
                case "ma_storage_owner" -> query(table, "storage_key=F|L", "binding_id=bindings",
                        "tenant_id=T&storage_id=D", "csi_registration_key=A");
                case "ma_runtime_slot" -> query(table, "request_key=requests", "active_binding_id=bindings",
                        "tenant_id=T&isolation_key=sessions");
                case "ma_runtime_session" -> query(table, "binding_id=bindings", "tenant_id=T&harness_session_id=sessions",
                        "scope_key=Bscope&runtime_session_id=runtime");
                case "ma_tenant_guard" -> query(table, "tenant_key=BT", "tenant_id=T");
                case "ma_session_journal_tx" -> query(table, "tenant_id=T&session_id=sessions");
                case "ma_resource" -> query(table, "session_scope_key=J", "tenant_id=T&session_id=sessions");
                case "ma_resource_ref" -> query(table, "session_scope_key=J", "tenant_id=T&session_id=sessions", "resource_key=resourceKeys");
                case "ma_read_lease" -> query(table, "tenant_key=RT&session_key=RS", "lease_id=reads");
                case "ma_schedule", "ma_schedule_occurrence" -> query(table, "tenant_id=T&session_id=sessions", "schedule_id=schedules");
                case "ma_channel_binding" -> query(table, "tenant_id=T&session_id=sessions");
                case "ma_operation", "ma_operation_work", "ma_request_receipt", "ma_delivery",
                        "ma_artifact", "ma_runtime_binding", "ma_tool_execution", "ma_output_capture" ->
                        new Query("1 = 1", List.of());
                default -> throw new IllegalStateException("Undeclared inventory table");
            };
        }

        private Query query(String table, String... terms) {
            Declaration declaration = CATALOGUE.stream().filter(value -> value.name().equals(table)).findFirst().orElseThrow();
            List<String> alternatives = new ArrayList<>();
            List<Cell> arguments = new ArrayList<>();
            for (String term : terms) {
                List<String> conjunction = new ArrayList<>();
                List<Cell> parameters = new ArrayList<>();
                for (String part : term.split("&")) {
                    String[] pair = part.split("=");
                    Column column = declaration.columns().stream().filter(value -> value.name().equals(pair[0])).findFirst().orElseThrow();
                    Set<String> choices = new TreeSet<>();
                    for (String namespace : pair[1].split("\\|")) {
                        choices.addAll(values(namespace));
                    }
                    if (choices.isEmpty()) {
                        conjunction.add("1 = 0");
                    } else {
                        conjunction.add("t." + pair[0] + " IN (" + String.join(",", Collections.nCopies(choices.size(), "?")) + ")");
                        choices.forEach(value -> parameters.add(new Cell(column.kind(), utf8(value))));
                    }
                }
                alternatives.add("(" + String.join(" AND ", conjunction) + ")");
                arguments.addAll(parameters);
            }
            return new Query(String.join(" OR ", alternatives), arguments);
        }

        private boolean context(String table, Row row) {
            if (!tenant.equals(row.text("tenant_id"))) {
                return false;
            }
            return switch (table) {
                case "ma_tenant_guard", "ma_agent_definition" -> true;
                case "ma_workspace_access", "ma_channel_instance" -> workspace.equals(row.text("workspace_id"));
                case "ma_workspace" -> "ROOT".equals(row.text("workspace_kind"))
                        && row.cell("parent_session_id").isNull() && row.cell("parent_workspace_id").isNull();
                case "ma_request_receipt" -> "SESSION_CREATE_MODE".equals(row.text("namespace"))
                        && "TENANT".equals(row.text("scope_kind")) && tenant.equals(row.text("scope_id"))
                        && has("creation", row.text("idempotency_key"));
                case "ma_storage" -> !intent.reservation().registrationKey().equals(row.text("alias_key"));
                default -> false;
            };
        }

        private Membership membership(String table, Row row) throws SQLException {
            if (owned(table, row)) {
                return Membership.ORIGINAL;
            }
            if (context(table, row)) {
                if (savedOriginalReference(table, row, liveReferences())) {
                    block(table, key(row), "context_original_reference");
                    return Membership.ORIGINAL;
                }
                return Membership.CONTEXT;
            }
            if (savedOriginalReference(table, row, liveReferences())) {
                block(table, key(row), "foreign_original_reference");
                return Membership.ORIGINAL;
            }
            if (!otherOwner(table, row)) {
                block(table, key(row), "unresolved_candidate_owner");
                return Membership.ORIGINAL;
            }
            return Membership.OTHER;
        }

        private boolean otherOwner(String table, Row row) throws SQLException {
            try {
                return switch (table) {
                    case "ma_runtime_binding" -> otherBinding(row);
                    case "ma_tool_execution", "ma_runtime_session" -> {
                        Row binding = lookup("ma_runtime_binding", "binding_id = ?", row.text("binding_id"));
                        boolean matches = binding != null && otherBinding(binding)
                                && Objects.equals(binding.number("runtime_generation"), row.number("runtime_generation"))
                                && Objects.equals(binding.text("isolation_key"), row.text("harness_session_id"));
                        yield matches && (table.equals("ma_tool_execution") ? otherExecution(row, binding)
                                : table.equals("ma_runtime_session")
                                        ? Objects.equals(binding.text("scope_key"), row.text("scope_key"))
                                                && Objects.equals(binding.text("tenant_id"), row.text("tenant_id"))
                                                && Objects.equals(binding.text("workspace_id"), row.text("workspace_id"))
                                        : Objects.equals(binding.text("request_key"), row.text("request_key"))
                                                && Objects.equals(binding.text("tenant_id"), row.text("tenant_id"))
                                                && Objects.equals(binding.text("workspace_id"), row.text("workspace_id")));
                    }
                    case "ma_session", "ma_turn", "ma_public_event", "ma_event_stream", "ma_message", "ma_snapshot",
                            "ma_session_record", "ma_session_journal_tx", "ma_channel_binding", "ma_schedule", "ma_schedule_occurrence" ->
                            otherSession(row.text("tenant_id"), row.text("workspace_id"), row.text("session_id"))
                                    && (row.cell("session_scope_key") == null || Objects.equals(row.text("session_scope_key"),
                                            ManagedSessionStore.sessionScopeKey(row.text("tenant_id"), row.text("session_id"))));
                    case "ma_resource" -> otherSession(row.text("tenant_id"), row.text("workspace_id"), row.text("session_id"))
                            && ManagedSessionStore.sessionScopeKey(row.text("tenant_id"), row.text("session_id"))
                                    .equals(row.text("session_scope_key"))
                            && ManagedSessionStore.resourceKey(row.text("session_scope_key"), row.text("resource_id"))
                                    .equals(row.text("resource_key"));
                    case "ma_request_receipt" -> isNativeRead(row) ? otherNativeRead(row) : otherCreationReceipt(row);
                    case "ma_output_capture" -> otherCapture(row);
                    case "ma_operation" -> otherOperation(row);
                    case "ma_operation_work" -> {
                        Row parent = lookup("ma_operation", "operation_key = ?", row.text("operation_key"));
                        JsonNode payload = parse(row.text("payload_json"));
                        yield parent != null && otherOperation(parent)
                                && !savedOriginalReference("ma_operation", parent, liveReferences())
                                && Objects.equals(parent.text("tenant_id"), row.text("tenant_id"))
                                && payload != null && payload.path("schemaVersion").asInt() == 1
                                && payload.path("data").isObject()
                                && Objects.equals(row.text("target_id"), payload.path("workKey").textValue())
                                && digest(row.text("target_id")).equals(row.text("target_key"));
                    }
                    case "ma_storage" -> {
                        WorkspaceCsiRegistration registered = registration(row.text("registration_json"));
                        yield registered != null && "CSI".equals(row.text("storage_kind"))
                                && "REGISTERED".equals(row.text("registration_state"))
                                && registered.tenantId().equals(row.text("tenant_id"))
                                && registered.storageId().equals(row.text("storage_id"))
                                && registered.aliasKey().equals(row.text("alias_key"))
                                && registered.physicalKey().equals(row.text("physical_key"))
                                && Objects.equals(registered.revision(), row.number("registration_revision"));
                    }
                    default -> false;
                };
            } catch (RuntimeException invalid) {
                return false;
            }
        }

        private boolean otherNativeRead(Row row) throws SQLException {
            var read = nativeReadEvidence(row);
            Row binding = lookup("ma_runtime_binding", "binding_id = ?", read.text("binding_id"));
            return binding != null && otherBinding(binding)
                    && Objects.equals(binding.text("tenant_id"), read.text("tenant_id"))
                    && Objects.equals(binding.text("workspace_id"), read.text("workspace_id"))
                    && Objects.equals(binding.text("isolation_key"), read.text("session_id"))
                    && Objects.equals(binding.text("request_key"), read.text("request_key"))
                    && Objects.equals(binding.number("runtime_generation"), read.number("runtime_generation"));
        }

        private boolean otherCreationReceipt(Row row) throws SQLException {
            var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.valueOf(row.text("namespace"));
            var scopeKind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.valueOf(row.text("scope_kind"));
            String ownerTenant = row.text("tenant_id");
            String scopeId = row.text("scope_id");
            String idempotency = row.text("idempotency_key");
            if (ownerTenant == null || scopeId == null || idempotency == null || row.text("request_digest") == null
                    || !com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.receiptKey(
                            namespace, ownerTenant, scopeKind, scopeId, idempotency).equals(row.text("receipt_key"))
                    || !com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(ownerTenant).equals(row.text("tenant_key"))
                    || !ManagedReceipts.scope(ownerTenant, scopeId).equals(row.text("scope_key"))
                    || !com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(idempotency).equals(row.text("idempotency_digest"))) {
                return false;
            }
            if (namespace == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.WORKSPACE_CREATE) {
                return otherWorkspaceCreationReceipt(row);
            }
            if (!row.cell("operation").isNull() || !row.cell("session_status_before").isNull()) {
                return false;
            }
            if (namespace == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_MODE) {
                Boolean bound = row.bool("workspace_bound");
                return scopeKind == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.TENANT
                        && ownerTenant.equals(scopeId) && bound != null && "RESERVED".equals(row.text("state"))
                        && row.cell("session_id").isNull() && row.cell("turn_id").isNull() && row.cell("actor_id").isNull()
                        && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(bound.toString()).equals(row.text("request_digest"));
            }
            if (namespace != com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_ACTOR
                    || scopeKind != com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR
                    || !Boolean.TRUE.equals(row.bool("workspace_bound")) || !"COMPLETED".equals(row.text("state"))
                    || row.binary("actor_id") == null || !ManagedReceipts.actorScope(row.binary("actor_id")).equals(scopeId)
                    || !otherSession(ownerTenant, null, row.text("session_id"))) {
                return false;
            }
            Row parent = lookup("ma_session", "tenant_id = ? AND session_id = ?", ownerTenant, row.text("session_id"));
            if (!Arrays.equals(parent.binary("creator_actor_key"), row.binary("actor_id"))) {
                return false;
            }
            if (row.text("turn_id") == null) {
                return true;
            }
            return lookup("ma_turn", "tenant_id = ? AND session_id = ? AND turn_id = ?",
                    ownerTenant, row.text("session_id"), row.text("turn_id")) != null;
        }

        private boolean otherWorkspaceCreationReceipt(Row row) throws SQLException {
            if (!"ACTOR".equals(row.text("scope_kind")) || !"COMPLETED".equals(row.text("state"))
                    || !"CREATE_WORKSPACE".equals(row.text("operation")) || row.text("tenant_id").isEmpty()
                    || row.binary("actor_id") == null || row.binary("actor_id").length == 0
                    || !ManagedReceipts.actorScope(row.binary("actor_id")).equals(row.text("scope_id"))
                    || !row.text("idempotency_key").matches("[\\x21-\\x7e]{1,128}")) {
                return false;
            }
            for (String field : List.of("workspace_bound", "session_id", "turn_id", "agent_id", "agent_revision",
                    "schedule_id", "channel_id", "account_generation", "semantic_revision", "action_id", "action_version",
                    "decision_scope_key", "mutation_attempt_sequence", "session_status_before", "result_operation_key")) {
                if (!row.cell(field).isNull()) {
                    return false;
                }
            }
            JsonNode details = parse(row.text("result_json"));
            WorkspaceCsiApplicationJson.closed(details, details.size() == 4
                    ? Set.of("workspaceId", "storageId", "displayName", "registrationId")
                    : Set.of("workspaceId", "storageId", "displayName", "registrationId",
                            "sourceWorkspaceId", "sourceGeneration", "cwdRelative"));
            for (String field : List.of("sourceWorkspaceId", "sourceGeneration", "cwdRelative")) {
                if (details.has(field) && !details.path(field).isNull()) {
                    return false;
                }
            }
            for (String field : List.of("workspaceId", "storageId", "displayName", "registrationId")) {
                if (!details.path(field).isTextual()) {
                    return false;
                }
            }
            String otherWorkspace = details.path("workspaceId").textValue();
            String otherStorage = details.path("storageId").textValue();
            String name = details.path("displayName").textValue();
            String registration = details.path("registrationId").textValue();
            if (!("workspace-" + row.text("receipt_key")).equals(otherWorkspace)
                    || !("created-" + row.text("receipt_key")).equals(otherStorage)
                    || name.isEmpty() || name.length() > 128 || !name.equals(name.strip())
                    || name.codePoints().anyMatch(Character::isISOControl)
                    || !com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(name).equals(row.text("request_digest"))
                    || !java.util.UUID.fromString(registration).toString().equals(registration)
                    || tenant.equals(row.text("tenant_id")) && (workspace.equals(otherWorkspace) || storage.equals(otherStorage))) {
                return false;
            }
            Row parent = lookup("ma_workspace", "tenant_id = ? AND workspace_id = ?", row.text("tenant_id"), otherWorkspace);
            Row alias = lookup("ma_storage", "alias_key = ?",
                    JdbcRuntimeBindingRepository.storageAliasKey(row.text("tenant_id"), otherStorage));
            if (parent == null || alias == null || !otherStorage.equals(parent.text("storage_id"))
                    || !"ROOT".equals(parent.text("workspace_kind"))
                    || parent.number("workspace_generation") == null || parent.number("workspace_generation") < 1
                    || !Set.of("ACTIVE", "REMOVED").contains(parent.text("state"))
                    || !row.text("tenant_id").equals(alias.text("tenant_id")) || !otherStorage.equals(alias.text("storage_id"))
                    || !JdbcRuntimeBindingRepository.storageFenceKey(row.text("tenant_id")).equals(alias.text("tenant_key"))
                    || !JdbcRuntimeBindingRepository.storageFenceKey(otherStorage).equals(alias.text("storage_key"))
                    || !"LOCAL".equals(alias.text("storage_kind")) || !"REGISTERED".equals(alias.text("registration_state"))
                    || alias.number("registration_revision") == null || alias.number("registration_revision") < 1
                    || !alias.cell("fence_operation_id").isNull() || alias.text("physical_key") == null
                    || !alias.text("physical_key").matches("[a-f0-9]{64}") || intent.physicalKey().equals(alias.text("physical_key"))
                    || savedOriginalReference("ma_workspace", parent, liveReferences())
                    || savedOriginalReference("ma_storage", alias, liveReferences())) {
                return false;
            }
            for (String field : List.of("child_state", "parent_workspace_id", "parent_session_id", "child_run_id", "child_workspace_id")) {
                if (!parent.cell(field).isNull()) {
                    return false;
                }
            }
            JsonNode registered = parse(alias.text("registration_json"));
            WorkspaceCsiApplicationJson.closed(registered, Set.of("schemaVersion", "operationId"));
            return registered.path("schemaVersion").isIntegralNumber() && registered.path("schemaVersion").canConvertToLong()
                    && registered.path("schemaVersion").longValue() == 1 && registration.equals(registered.path("operationId").textValue());
        }

        private boolean otherCapture(Row row) throws SQLException {
            JsonNode binding = ToolPublicationContract.parseBytes("binding", row.binary("binding_json"));
            JsonNode key = binding.path("sessionKey");
            return otherSession(row.text("tenant_id"), row.text("workspace_id"), row.text("session_id"))
                    && row.text("tenant_id").equals(key.path("tenantId").textValue())
                    && row.text("workspace_id").equals(key.path("workspaceId").textValue())
                    && row.text("session_id").equals(key.path("sessionId").textValue())
                    && ToolPublicationDataStore.scope(row.text("tenant_id"), row.text("workspace_id"), row.text("session_id"))
                            .equals(row.text("scope_key"))
                    && ToolPublicationRetentionStore.hash(row.text("tenant_id")).equals(row.text("tenant_key"))
                    && row.text("publication_id").equals(binding.path("publicationId").textValue())
                    && ToolPublicationContract.bindingDigest(binding).equals(row.text("binding_digest"))
                    && hash(utf8(binding.path("executionCallId").textValue())).equals(row.text("execution_key"));
        }

        private boolean otherOperation(Row row) throws SQLException {
            String otherTenant = row.text("tenant_id");
            String otherId = row.text("operation_id");
            String otherSession = row.text("session_id");
            if (otherTenant == null || otherId == null || row.text("request_json") == null
                    || parse(row.text("request_json")) == null) {
                return false;
            }
            if ("CSI_RETIREMENT".equals(row.text("operation_kind"))) {
                var retained = retirement(row);
                Row binding = lookup("ma_runtime_binding", "binding_id = ?", retained.reservation().bindingId());
                return binding != null && otherBinding(binding)
                        && otherTenant.equals(binding.text("tenant_id"))
                        && Objects.equals(binding.number("runtime_generation"), row.number("target_revision"));
            }
            if (otherSession == null || !otherSession(otherTenant, row.text("workspace_id"), otherSession)
                    || !ManagedSessionStore.sessionScopeKey(otherTenant, otherSession).equals(row.text("session_scope_key"))) {
                return false;
            }
            var kind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.valueOf(row.text("operation_kind"));
            return com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(kind,
                    row.text("scope_key"), row.text("target_key"), otherId).equals(row.text("operation_key"));
        }

        private boolean owned(String table, Row row) {
            if (rawSession(row) || tenant.equals(row.text("tenant_id"))
                    && (session.equals(row.text("harness_session_id")) || session.equals(row.text("isolation_key"))
                    || session.equals(row.text("parent_session_id")) || session.equals(row.text("root_session_id"))
                    || session.equals(row.text("source_session_id")) || session.equals(row.text("target_session_id")))) {
                return true;
            }
            if (original.bindingId().equals(row.text("binding_id")) || original.bindingId().equals(row.text("active_binding_id"))
                    || original.request().requestKey().equals(row.text("request_key"))
                    || original.request().requestKey().equals(row.text("runtime_request_key"))
                    || has("J", row.text("session_scope_key"))) {
                return true;
            }
            return switch (table) {
                case "ma_operation" -> "CSI_RETIREMENT".equals(row.text("operation_kind"))
                        && original.bindingId().equals(row.text("target_id"));
                case "ma_operation_work" -> has("operationKeys", row.text("operation_key"));
                case "ma_storage" -> intent.reservation().registrationKey().equals(row.text("alias_key"));
                case "ma_storage_owner" -> intent.physicalKey().equals(row.text("storage_key"));
                case "ma_read_lease" -> has("RT", row.text("tenant_key")) && has("RS", row.text("session_key"));
                default -> false;
            };
        }

        private Map<String, Set<String>> liveReferences() {
            var references = new LinkedHashMap<String, Set<String>>();
            references.put("tenant", Set.of(tenant));
            references.put("session", values("sessions"));
            references.put("binding", values("bindings"));
            references.put("request", values("requests"));
            references.put("retirement", values("retirements"));
            references.put("reservation", Set.of(intent.reservation().reservationId()));
            references.put("provision", Set.of(intent.reservation().provisionRequestId()));
            references.put("execution", values("executions"));
            references.put("executionHash", values("executionHashes"));
            references.put("scopedSession", Set.copyOf(List.of(ManagedSessionStore.sessionScopeKey(tenant, session), ManagedToolResultStore.scope(tenant, session),
                    com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("csi-read", tenant, session))));
            references.put("sessionKey", Set.of(ToolPublicationRetentionStore.hash(session)));
            references.put("resourceRead", values("reads"));
            references.put("operationKey", values("operationKeys"));
            references.put("resourceKey", values("resourceKeys"));
            return references;
        }

        private boolean otherSession(String otherTenant, String otherWorkspace, String otherId) throws SQLException {
            if (otherTenant == null || otherId == null || tenant.equals(otherTenant) && has("sessions", otherId)) {
                return false;
            }
            Row other = lookup("ma_session", "tenant_id = ? AND session_id = ?", otherTenant, otherId);
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
            Row parent = lookup("ma_session", "tenant_id = ? AND session_id = ?",
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
                        && !savedOriginalReference("ma_runtime_binding", row, liveReferences());
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
                    var fields = java.util.regex.Pattern.compile("(\\w+)\\s*=\\s*\\?").matcher(predicate);
                    String field = null;
                    for (int at = 0; at <= index; at++) {
                        requireEncoded(fields.find());
                        field = fields.group(1);
                    }
                    String name = field;
                    var column = declaration.columns().stream().filter(value -> value.name().equals(name)).findFirst().orElseThrow();
                    historicalParameter(statement, index + 1, new Cell(column.kind(), utf8(parameters[index])));
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
                if (field.getValue().isNull() || field.getValue().kind.binary()
                        && (field.getValue().kind != Kind.VARBINARY || !IDENTITY_FIELDS.contains(field.getKey()))) {
                    continue;
                }
                seed(field.getKey(), row.text(field.getKey()));
                if (field.getKey().endsWith("_json")) {
                    JsonNode json = parse(field.getValue().text());
                    if (json == null) {
                        block(table, key(row), "malformed_association_json");
                    } else {
                        seedJson(json);
                    }
                }
            }
            if (table.equals("ma_request_receipt") && "SESSION_CREATE_ACTOR".equals(row.text("namespace"))) {
                id("creation", row.text("idempotency_key"));
            }
            if (table.equals("ma_session")) {
                id("agent", row.text("agent_id"));
                String revision = row.text("agent_revision");
                if (revision != null && revision.matches("[1-9][0-9]{0,18}")
                        && new BigInteger(revision).compareTo(BigInteger.valueOf(Long.MAX_VALUE)) <= 0) {
                    id("agentRevision", revision);
                }
            }
            if (table.equals("ma_session_journal_tx")) {
                try {
                    for (JsonNode record : com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.records(row.binary("record_bytes"))) {
                        seedJson(record);
                    }
                } catch (RuntimeException exception) {
                    block(table, key(row), "malformed_native_records");
                }
            }
            if (table.equals("ma_resource") && row.binary("inline_bytes") != null && !chunkPart(row.text("kind"))) {
                JsonNode json = parse(row.binary("inline_bytes"));
                if (json == null) {
                    block(table, key(row), "malformed_native_resource");
                } else {
                    seedJson(json);
                }
            }
        }

        private void expandNativeChunks() {
            var resources = rows("ma_resource").stream().filter(row -> row.membership == Membership.ORIGINAL).toList();
            for (Row manifest : resources.stream().filter(row -> chunkManifest(row.text("kind"))).toList()) {
                try {
                    seedJson(chunkBody(manifest, ref -> chunkMember(manifest, ref, resources), new LinkedHashSet<>()));
                } catch (RuntimeException invalid) {
                    // Discovery can precede loading all members; final validation refuses an incomplete group.
                }
            }
        }

        private void validateNativeChunks() {
            var resources = rows("ma_resource").stream().filter(row -> row.membership == Membership.ORIGINAL).toList();
            Set<String> covered = new LinkedHashSet<>();
            for (Row manifest : resources.stream().filter(row -> chunkManifest(row.text("kind"))).toList()) {
                Set<String> consumed = new LinkedHashSet<>();
                try {
                    chunkBody(manifest, ref -> chunkMember(manifest, ref, resources), consumed);
                    covered.addAll(consumed);
                } catch (RuntimeException invalid) {
                    block("ma_resource", key(manifest), "invalid_native_chunks");
                }
            }
            for (Row part : resources.stream().filter(row -> chunkPart(row.text("kind"))).toList()) {
                expect("ma_resource", part, covered.contains(key(part)));
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
                case "resource_key" -> "resourceKeys";
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
            for (String table : List.of("ma_session", "ma_public_event", "ma_event_stream", "ma_storage",
                    "ma_operation", "ma_storage_owner", "ma_runtime_binding", "ma_runtime_slot", "ma_runtime_session", "ma_session_head")) {
                if (rows(table).stream().filter(row -> row.membership == Membership.ORIGINAL).count() != 1) {
                    block(table, null, "missing_or_extra_original");
                }
            }
            for (String namespace : List.of("SESSION_CREATE_MODE", "SESSION_CREATE_ACTOR")) {
                if (rows("ma_request_receipt").stream().filter(row -> row.membership != Membership.OTHER
                        && namespace.equals(row.text("namespace"))).count() != 1) {
                    block("ma_request_receipt", namespace, "missing_or_extra_original");
                }
            }
            for (String domain : List.of("runtime_placement", "output_publication")) {
                if (rows("ma_tenant_guard").stream().filter(row -> row.membership == Membership.CONTEXT
                        && domain.equals(row.text("guard_domain"))).count() != 1) {
                    block("ma_tenant_guard", domain, "missing_or_extra_original");
                }
            }
            validateNativeMembership();
        }

        private void validateRow(String table, Row row) {
            switch (table) {
                case "ma_session" -> {
                    expect(table, row, rawSession(row) && "ACTIVE".equals(row.text("status")) && row.cell("deleted_at").isNull()
                            && CsiFilesRetirementProfile.PROFILE.equals(row.text("tool_profile"))
                            && row.cell("model_id").isNull() && Objects.equals(0L, row.number("model_revision"))
                            && row.cell("selected_approval_mode").isNull() && Objects.equals(0L, row.number("approval_revision"))
                            && Boolean.FALSE.equals(row.bool("plan_enabled"))
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
                            && Objects.equals(0L, row.number("version"))
                            && "PUBLIC".equals(row.text("session_kind"))
                            && Objects.equals(0L, row.number("retirement_generation"))
                            && row.cell("retired_at").isNull() && row.cell("retirement_operation_id").isNull()
                            && Boolean.FALSE.equals(row.bool("recovery_protected")) && Boolean.FALSE.equals(row.bool("resource_gc_completed"))
                            && Objects.equals(0L, row.number("harness_last_event_id"))
                            && row.cell("harness_boot_id").isNull() && row.cell("harness_event_epoch").isNull()
                            && Objects.equals(row.number("gmt_create"), row.number("gmt_modified")));
                }
                case "ma_public_event" -> {
                    if ("TASK".equals(row.text("stream_kind"))) {
                        block(table, key(row), "unsupported_first_lane");
                        break;
                    }
                    JsonNode data = parse(row.text("data_json"));
                    Row parent = originalRow("ma_session");
                    expect(table, row, rawSession(row) && "SESSION".equals(row.text("stream_kind")) && "".equals(row.text("stream_id")) && "session.created".equals(row.text("event_type"))
                            && row.cell("turn_id").isNull() && row.cell("source_key").isNull() && Boolean.FALSE.equals(row.bool("terminal"))
                            && Objects.equals(1L, row.number("sequence_id")) && data != null && data.isObject()
                            && data.size() == 1 && session.equals(data.path("sessionId").textValue())
                            && parent != null && Objects.equals(parent.number("gmt_create"), row.number("gmt_create"))
                            && Objects.equals(1L, row.number("schema_version")) && Objects.equals(1L, row.number("projection_version"))
                            && row.cell("item_id").isNull() && row.cell("content_part_id").isNull());
                }
                case "ma_workspace" -> {
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
                case "ma_storage" -> {
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
                case "ma_operation" -> {
                    var value = parse(row.text("request_json"));
                    expect(table, row, intent.operationId().equals(row.text("operation_id"))
                            && original.bindingId().equals(row.text("target_id"))
                            && Objects.equals(original.generation(), row.number("target_revision"))
                            && intent.equals(retirement(row))
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
                case "ma_storage_owner" -> expect(table, row,
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
                case "ma_runtime_slot" -> expect(table, row, request(row)
                        && original.bindingId().equals(row.text("active_binding_id"))
                        && Objects.equals(original.generation(), row.number("last_generation")));
                case "ma_runtime_binding" -> expect(table, row, request(row)
                        && original.bindingId().equals(row.text("binding_id")) && has("Bscope", row.text("scope_key"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && "DRAINING".equals(row.text("binding_state")) && Boolean.TRUE.equals(row.bool("drain_requested"))
                        && intent.runtimeInstanceId().equals(row.text("runtime_instance_id"))
                        && intent.leaseId().equals(row.text("runtime_lease_id")) && Objects.equals(intent.epoch(), row.number("runtime_epoch"))
                        && matches(parse(row.text("resource_handle_json")), parse(intent.resourceHandleJson()))
                        && Objects.equals(intent.resourceHandleVersion().longValue(), row.number("resource_handle_version"))
                        && Objects.equals(intent.attestationGeneration(), row.number("attestation_generation")));
                case "ma_runtime_session" -> expect(table, row, scope(row)
                        && original.bindingId().equals(row.text("binding_id")) && session.equals(row.text("runtime_session_id"))
                        && session.equals(row.text("harness_session_id")) && "bootstrap".equals(row.text("turn_kind"))
                        && Objects.equals(original.generation(), row.number("runtime_generation"))
                        && oneOf(row.text("session_state"), "READY", "RELEASED"));
                case "ma_session_head" -> expect(table, row, rawNative(row)
                        && "MANAGED_SESSION".equals(row.text("head_kind"))
                        && "OPEN".equals(row.text("phase")) && row.cell("operation_id").isNull()
                        && Objects.equals(0L, row.number("claim_generation")) && row.cell("claim_lease_until").isNull()
                        && session.equals(row.text("harness_session_id"))
                        && has("BT", row.text("tenant_key")) && has("BS", row.text("harness_key"))
                        && Objects.equals(1L, row.number("storage_version"))
                        && oneOf(row.text("state"), "ACTIVE", "SEALED") && "READY".equals(row.text("recovery_status"))
                        && row.cell("recovery_detail_code").isNull() && Objects.equals(0L, row.number("compacted_through_revision"))
                        && row.number("journal_revision") != null && row.number("journal_revision") > 0
                        && row.number("writer_generation") != null && row.number("writer_generation") > 0
                        && row.text("writer_id") != null && row.text("lease_token_hash") != null
                        && row.text("writer_lease_until") != null && row.text("activation_id") != null);
                case "ma_session_journal_tx" -> expect(table, row, rawNative(row)
                        && "identity".equals(row.text("record_encoding")) && row.binary("record_bytes") != null
                        && Objects.equals((long) row.binary("record_bytes").length, row.number("byte_length"))
                        && hash(row.binary("record_bytes")).equals(row.text("record_digest")));
                case "ma_resource" -> expect(table, row, rawNative(row)
                        && ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey(tenant, session), row.text("resource_id")).equals(row.text("resource_key"))
                        && row.cell("deletion_operation_key").isNull()
                        && row.cell("scope_key").isNull() && row.cell("publication_id").isNull() && row.cell("capture_state").isNull()
                        && has("J", row.text("session_scope_key"))
                        && "MYSQL_INLINE".equals(row.text("storage_kind")) && "REFERENCED".equals(row.text("state"))
                        && row.binary("inline_bytes") != null
                        && Objects.equals((long) row.binary("inline_bytes").length, row.number("byte_length"))
                        && hash(row.binary("inline_bytes")).equals(row.text("sha256"))
                        && row.cell("object_key").isNull() && row.cell("object_version_id").isNull()
                        && row.cell("encryption_key_id").isNull());
                case "ma_session_record" -> expect(table, row, rawNative(row) && has("J", row.text("session_scope_key")));
                case "ma_resource_ref" -> expect(table, row, rawNative(row)
                        && has("J", row.text("session_scope_key"))
                        && ("JOURNAL".equals(row.text("owner_kind")) && has("J", row.text("owner_key"))
                                && Objects.equals(row.number("owner_revision"), row.number("journal_revision"))
                                || "SESSION_RECORD".equals(row.text("owner_kind")) && row.cell("journal_revision").isNull())
                        && ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey(tenant, session), row.text("resource_id")).equals(row.text("resource_key")));
                case "ma_tool_execution" -> expect(table, row, original.bindingId().equals(row.text("binding_id"))
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
                case "ma_event_stream" -> {
                    Row parent = originalRow("ma_session");
                    expect(table, row, rawSession(row) && "SESSION".equals(row.text("stream_kind"))
                            && "".equals(row.text("stream_id")) && Objects.equals(1L, row.number("last_sequence"))
                            && Objects.equals(0L, row.number("covered_sequence")) && Objects.equals(0L, row.number("replay_floor_sequence"))
                            && row.cell("wake_covered_sequence").isNull() && row.cell("snapshot_stale_since").isNull()
                            && row.cell("current_snapshot_id").isNull() && row.cell("artifact_refs_resource_key").isNull()
                            && row.cell("output_ranges_json").isNull() && Objects.equals(1L, row.number("projection_version"))
                            && Boolean.TRUE.equals(row.bool("projection_pending")) && parent != null
                            && Objects.equals(parent.number("gmt_create"), row.number("gmt_modified")));
                }
                case "ma_request_receipt" -> {
                    if (isNativeRead(row)) {
                        var read = nativeReadEvidence(row);
                        expect(table, row, tenant.equals(read.text("tenant_id"))
                                && workspace.equals(read.text("workspace_id")) && session.equals(read.text("session_id"))
                                && original.bindingId().equals(read.text("binding_id"))
                                && Objects.equals(original.generation(), read.number("runtime_generation"))
                                && original.request().requestKey().equals(read.text("request_key"))
                                && "RETURNED".equals(row.text("state")) && "verified".equals(read.text("outcome_code"))
                                && read.number("ended_at") != null && read.number("ended_at") >= read.number("started_at")
                                && read.number("ended_at") < read.number("delivery_expires_at"));
                        break;
                    }
                    var namespace = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.valueOf(row.text("namespace"));
                    var scopeKind = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.valueOf(row.text("scope_kind"));
                    String scopeId = row.text("scope_id");
                    String idempotency = row.text("idempotency_key");
                    expect(table, row, tenant.equals(row.text("tenant_id")) && has("RT", row.text("tenant_key"))
                            && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.receiptKey(namespace, tenant, scopeKind, scopeId, idempotency).equals(row.text("receipt_key"))
                            && ManagedReceipts.scope(tenant, scopeId).equals(row.text("scope_key"))
                            && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(idempotency).equals(row.text("idempotency_digest"))
                            && row.cell("turn_id").isNull() && row.cell("operation").isNull() && row.cell("session_status_before").isNull()
                            && Boolean.TRUE.equals(row.bool("workspace_bound")) && row.text("request_digest") != null);
                    if (namespace == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_MODE) {
                        expect(table, row, scopeKind == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.TENANT
                                && tenant.equals(scopeId) && has("creation", idempotency) && row.cell("session_id").isNull()
                                && row.cell("actor_id").isNull() && "RESERVED".equals(row.text("state"))
                                && com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key("true").equals(row.text("request_digest")));
                    } else if (namespace == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_ACTOR) {
                        Row parent = originalRow("ma_session");
                        expect(table, row, parent != null && rawSession(row) && "COMPLETED".equals(row.text("state"))
                                && scopeKind == com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR
                                && Arrays.equals(parent.binary("creator_actor_key"), row.binary("actor_id"))
                                && ManagedReceipts.actorScope(row.binary("actor_id")).equals(scopeId)
                                && Objects.equals(parent.number("gmt_create"), row.number("gmt_create")));
                    } else {
                        block(table, key(row), "unsupported_first_lane");
                    }
                }
                case "ma_tenant_guard" -> expect(table, row, tenant.equals(row.text("tenant_id"))
                        && has("BT", row.text("tenant_key")) && oneOf(row.text("guard_domain"), "runtime_placement", "output_publication"));
                case "ma_workspace_access", "ma_channel_instance" -> expect(table, row, tenant.equals(row.text("tenant_id")) && workspace.equals(row.text("workspace_id")));
                case "ma_agent_definition" -> {
                    Row parent = originalRow("ma_session");
                    expect(table, row, parent != null && tenant.equals(row.text("tenant_id"))
                            && Objects.equals(parent.text("agent_id"), row.text("agent_id"))
                            && Objects.equals(parent.text("agent_revision"), String.valueOf(row.number("revision"))));
                }
                default -> block(table, key(row), "unsupported_first_lane");
            }
        }

        private Row originalRow(String table) {
            var found = rows(table).stream().filter(row -> row.membership == Membership.ORIGINAL).toList();
            return found.size() == 1 ? found.getFirst() : null;
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
            validateNativeChunks();
            Row head = originalRow("ma_session_head");
            var transactions = rows("ma_session_journal_tx").stream()
                    .filter(row -> row.membership != Membership.OTHER).sorted(WorkspaceCsiApplicationInventory::compareKeys).toList();
            long revision = 0;
            long sequence = 0;
            String previousDigest = null;
            for (Row transaction : transactions) {
                expect("ma_session_journal_tx", transaction,
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
                block("ma_session_head", null, "journal_membership_mismatch");
            }
            Map<String, Row> resources = new LinkedHashMap<>();
            for (Row row : rows("ma_resource").stream().filter(value -> value.membership == Membership.ORIGINAL).toList()) {
                if (resources.putIfAbsent(row.text("resource_id"), row) != null) {
                    block("ma_resource", key(row), "duplicate_resource_identity");
                }
            }
            Row modelContext = null;
            try {
                modelContext = modelContextReference(transactions, rows("ma_session_record"), rows("ma_resource"),
                        rows("ma_resource_ref"), original.request(), Math.addExact(Instant.parse(intent.startedAt()).toEpochMilli(), 300_000));
            } catch (RuntimeException invalid) {
                block("ma_session_record", null, "invalid_hosted_model_context");
            }
            Set<String> referenced = new LinkedHashSet<>();
            for (Row ref : rows("ma_resource_ref").stream().filter(value -> value.membership == Membership.ORIGINAL).toList()) {
                referenced.add(ref.text("resource_id"));
                Long at = ref.number("journal_revision");
                expect("ma_resource_ref", ref, resources.containsKey(ref.text("resource_id"))
                        && (modelContext != null && Arrays.equals(modelContext.bytes(), ref.bytes())
                                || "JOURNAL".equals(ref.text("owner_kind")) && at != null && at > 0 && at <= revision));
            }
            for (Row resource : resources.values()) {
                expect("ma_resource", resource, referenced.contains(resource.text("resource_id")));
            }
            for (Row receipt : rows("ma_request_receipt").stream()
                    .filter(value -> value.membership == Membership.ORIGINAL && isNativeRead(value)).toList()) {
                NativeReadEvidence read;
                try {
                    read = nativeReadEvidence(receipt);
                } catch (RuntimeException invalid) {
                    block("ma_request_receipt", key(receipt), "invalid_native_read_receipt");
                    continue;
                }
                Row resource = resources.get(read.text("resource_id"));
                Row transaction = transactions.stream().filter(row -> Objects.equals(row.number("journal_revision"),
                        read.number("journal_revision"))).findFirst().orElse(null);
                expect("ma_request_receipt", receipt, resource != null && transaction != null && head != null
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

    private record Query(String sql, List<Cell> arguments) {
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
        return org.apache.commons.codec.digest.DigestUtils.sha256Hex(bytes);
    }
}
