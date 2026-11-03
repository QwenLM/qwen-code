-- Fresh Managed Agent schema. This resource is the only baseline consumed by JDBC and Flyway.
-- Until the first formal Managed Agent release, edit this V1 baseline in place.
-- Do not add V2+ migrations or increment the database schema version before that release.
-- Development catalogs must be recreated when the baseline changes; no upgrade path is maintained.
-- No old-schema upgrade or compatibility objects are provided.
-- Generated-column comments stay on a continuation line because validation reads the expression line.

CREATE TABLE ma_session (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    agent_id VARBINARY(512) COMMENT 'Agent definition identity selected for the Session.',
    title VARCHAR(512) COMMENT 'Display title of the Session.',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' COMMENT 'Public Session lifecycle status.',
    harness_boot_id VARBINARY(144) COMMENT 'Harness process boot identity last associated with the Session.',
    harness_event_epoch VARBINARY(256) COMMENT 'Harness event epoch used to distinguish event stream incarnations.',
    harness_last_event_id BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last Harness event identifier observed in the recorded epoch.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Optimistic concurrency version of the record.',
    CONSTRAINT pk_ma_session PRIMARY KEY (tenant_id, session_id),
    public_session_id VARBINARY(512) GENERATED ALWAYS AS (CASE WHEN session_kind = 'PUBLIC' THEN session_id ELSE NULL END)
        COMMENT 'Generated public Session identity enforcing global uniqueness for PUBLIC rows.',
    CONSTRAINT uk_ma_session_public_session_id UNIQUE (public_session_id),
    deleted_at BIGINT UNSIGNED COMMENT 'Logical deletion time in Unix epoch milliseconds.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    workspace_generation BIGINT UNSIGNED COMMENT 'Workspace generation captured for this binding.',
    workspace_storage_id VARBINARY(1024) COMMENT 'Logical storage identity pinned by the Workspace binding.',
    cwd_relative VARCHAR(2048) COMMENT 'Working directory relative to the Workspace root.',
    context_config_ref VARBINARY(2048) COMMENT 'Reference to the selected Session context configuration.',
    context_revision BIGINT UNSIGNED COMMENT 'Revision of the Session working-directory and context configuration.',
    workspace_config_ref VARBINARY(2048) COMMENT 'Reference to the pinned Workspace configuration.',
    workspace_policy_ref VARBINARY(2048) COMMENT 'Reference to the pinned Workspace policy.',
    agent_revision VARCHAR(128) NOT NULL DEFAULT '1' COMMENT 'Pinned Agent definition revision.',
    approval_mode VARCHAR(32) NOT NULL DEFAULT 'yolo' COMMENT 'Initial approval policy captured when the Session was created.',
    tool_profile VARCHAR(64) DEFAULT 'hosted-workspace-files/1' COMMENT 'Hosted tool capability profile admitted for the Session.',
    creator_actor_key VARBINARY(2048) NULL COMMENT 'Encoded identity of the actor that created the Session.',
    owner_actor_key VARBINARY(2048) NULL COMMENT 'Encoded identity of the actor that owns the Session.',
    parent_session_id VARBINARY(512) NULL COMMENT 'Immediate parent Session identity for a child Session.',
    root_session_id VARBINARY(512) NULL COMMENT 'Root Session identity of the child-Session lineage.',
    parent_child_run_id VARBINARY(2048) NULL COMMENT 'Child-run identity in the immediate parent Session.',
    child_depth INT UNSIGNED NULL COMMENT 'Depth of the Session in its child-Session lineage.',
    agent_definition_digest CHAR(64) NULL COMMENT 'Digest of the immutable Agent definition selected at admission.',
    session_kind VARCHAR(16) NOT NULL DEFAULT 'PUBLIC' COMMENT 'PUBLIC for user-visible Sessions or CONTROL for internal lifecycle records.',
    tenant_key CHAR(64) COMMENT 'Hashed tenant identity used for indexed lookup.',
    session_key CHAR(64) COMMENT 'Hashed Session identity used for indexed lookup.',
    session_scope_key CHAR(64) COMMENT 'Hashed tenant and Session identity used to scope related records.',
    title_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic title revision preventing stale rename settlement.',
    retirement_operation_id VARBINARY(512) COMMENT 'Operation identity that initiated permanent Session retirement.',
    retirement_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic retirement generation fencing readers and resource mutations.',
    retired_at BIGINT UNSIGNED COMMENT 'Permanent retirement time in Unix epoch milliseconds.',
    is_recovery_protected TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether recovery evidence currently prevents resource collection.',
    is_resource_gc_completed TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether permanent Session resource collection has completed.',
    CONSTRAINT ck_ma_session_kind CHECK ((CASE session_kind WHEN 'PUBLIC' THEN 6 WHEN 'CONTROL' THEN 7 ELSE -1 END = CHAR_LENGTH(session_kind))),
    CONSTRAINT ck_ma_session_resource_gc CHECK (CASE is_resource_gc_completed WHEN 0 THEN 1 WHEN 1 THEN 1 ELSE 0 END = 1),
    CONSTRAINT ck_ma_public_agent CHECK (session_kind = 'CONTROL' OR agent_id IS NOT NULL),
    CONSTRAINT ck_ma_session_binding CHECK (session_kind = 'CONTROL' OR ((workspace_id IS NULL AND workspace_generation IS NULL AND workspace_storage_id IS NULL AND cwd_relative IS NULL AND context_config_ref IS NULL AND context_revision IS NULL AND workspace_config_ref IS NULL AND workspace_policy_ref IS NULL) OR (workspace_id IS NOT NULL AND workspace_generation IS NOT NULL AND workspace_generation > 0 AND workspace_storage_id IS NOT NULL AND cwd_relative IS NOT NULL AND context_config_ref IS NOT NULL AND context_revision IS NOT NULL AND context_revision > 0 AND workspace_config_ref IS NOT NULL AND workspace_policy_ref IS NOT NULL))),
    CONSTRAINT uk_ma_session_hash UNIQUE (tenant_key, session_key),
    CONSTRAINT uk_ma_session_scope UNIQUE (session_scope_key),
    runtime_request_key CHAR(64) COMMENT 'Runtime request slot pinned for private CSI execution.',
    is_csi_guard TINYINT UNSIGNED GENERATED ALWAYS AS (COALESCE(tool_profile = 'csi-files-retirement/1' OR runtime_request_key IS NOT NULL, 0))
        COMMENT 'Generated flag identifying Sessions requiring private CSI admission checks.',
    model_id VARBINARY(512) COMMENT 'Selected model identity from the configured model catalog.',
    model_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of the explicit model selection.',
    model_config_digest VARCHAR(71) COMMENT 'Digest of the canonical Session model configuration.',
    model_config_key_id VARCHAR(512) COMMENT 'Encryption key identity used for the Session model configuration.',
    model_config_ciphertext LONGTEXT COMMENT 'Encrypted Session model configuration.',
    CONSTRAINT ck_ma_session_model_config CHECK ((model_config_digest IS NULL AND model_config_key_id IS NULL AND model_config_ciphertext IS NULL) OR (model_config_digest IS NOT NULL AND model_config_key_id IS NOT NULL AND model_config_ciphertext IS NOT NULL)),
    CONSTRAINT ck_ma_session_model_selection CHECK ((model_id IS NULL AND model_revision = 0) OR (model_id IS NOT NULL AND model_revision >= 1 AND model_revision <= 9007199254740991)),
    selected_approval_mode VARCHAR(32) COMMENT 'Explicit current approval override, or NULL to use the initial policy.',
    approval_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of the selected tool approval policy.',
    CONSTRAINT ck_ma_session_approval_selection CHECK ((selected_approval_mode IS NULL AND approval_revision = 0) OR (selected_approval_mode IS NOT NULL AND approval_revision >= 1 AND approval_revision <= 9007199254740991 AND (CASE selected_approval_mode WHEN 'default' THEN 7 WHEN 'auto' THEN 4 WHEN 'auto-edit' THEN 9 WHEN 'yolo' THEN 4 ELSE -1 END = CHAR_LENGTH(selected_approval_mode)))),
    is_plan_enabled TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether Plan mode is enabled for this policy.',
    permission_rules_json LONGTEXT COMMENT 'Serialized tool permission rules associated with the approval policy.',
    CONSTRAINT ck_ma_session_permission_rules CHECK (permission_rules_json IS NULL OR (selected_approval_mode IS NOT NULL AND approval_revision >= 1 AND OCTET_LENGTH(permission_rules_json) <= 8192)),
    CONSTRAINT ck_ma_session_plan CHECK (is_plan_enabled = 0 OR (selected_approval_mode IS NOT NULL AND approval_revision >= 1)),
    public_child_agents_version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Public child-Agent protocol version, with zero meaning disabled.',
    CONSTRAINT ck_ma_public_child_agents CHECK (public_child_agents_version >= 0 AND public_child_agents_version <= 1),
    harness_instance_id VARBINARY(144) COMMENT 'Harness pool instance currently assigned to the Session.',
    harness_owner_boot_id VARBINARY(144) COMMENT 'Boot identity of the Harness process owning the assignment.',
    harness_placement_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic Harness assignment generation.',
    harness_placement_state VARCHAR(16) NOT NULL DEFAULT 'UNASSIGNED' COMMENT 'Harness assignment state: UNASSIGNED, ACTIVE, QUIESCING, or RELEASED.',
    CONSTRAINT ck_ma_harness_placement CHECK ((harness_placement_state = 'UNASSIGNED' AND harness_instance_id IS NULL AND harness_owner_boot_id IS NULL AND harness_placement_epoch = 0) OR (harness_instance_id IS NOT NULL AND harness_owner_boot_id IS NOT NULL AND harness_placement_epoch > 0 AND (CASE harness_placement_state WHEN 'ACTIVE' THEN 6 WHEN 'QUIESCING' THEN 9 WHEN 'RELEASED' THEN 8 ELSE -1 END = CHAR_LENGTH(harness_placement_state)))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT uk_ma_session_id UNIQUE (id),
    CONSTRAINT ck_ma_session_boolean_values CHECK ((is_recovery_protected >= 0 AND is_recovery_protected <= 1) AND (is_resource_gc_completed >= 0 AND is_resource_gc_completed <= 1) AND (is_csi_guard >= 0 AND is_csi_guard <= 1) AND (is_plan_enabled >= 0 AND is_plan_enabled <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Managed Session identity, lifecycle, Workspace binding, and execution preferences.';

CREATE INDEX idx_ma_harness_owner ON ma_session (harness_instance_id, harness_owner_boot_id, harness_placement_state, tenant_id, session_id);

CREATE INDEX idx_ma_session_retirement ON ma_session (retired_at, is_recovery_protected);

CREATE INDEX idx_ma_session_storage_scope ON ma_session (tenant_id, workspace_storage_id, is_resource_gc_completed, session_id);

CREATE TABLE ma_user_message_queue (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    is_paused TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether automatic dispatch from this Session queue is paused.',
    resumed_turn_id VARBINARY(256) COMMENT 'Turn associated with the latest queue resume.',
    next_sequence BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Next monotonically increasing input queue sequence.',
    last_dispatch_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last queue dispatch time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_user_message_queue_business_key UNIQUE (tenant_id, session_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_user_message_queue_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_user_message_queue_boolean_values CHECK ((is_paused >= 0 AND is_paused <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Per-Session input queue ordering, pause state, and dispatch progress.';

CREATE TABLE ma_user_message (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    message_id VARBINARY(144) NOT NULL COMMENT 'Stable identity of the queued user input.',
    sequence_number BIGINT UNSIGNED NOT NULL COMMENT 'FIFO position of the input within the Session.',
    revision BIGINT UNSIGNED NOT NULL COMMENT 'Input revision used to reject stale edits or withdrawals.',
    actor_id VARBINARY(512) NOT NULL COMMENT 'Actor identity associated with this record.',
    input_json LONGTEXT NOT NULL COMMENT 'Serialized user input blocks.',
    state VARCHAR(32) NOT NULL COMMENT 'Input queue state, including queued, claimed, consumed, or recovery_blocked.',
    context_revision BIGINT UNSIGNED COMMENT 'Session context revision captured when the input was queued.',
    turn_id VARBINARY(256) COMMENT 'Turn identity within the Session.',
    prompt_id VARBINARY(144) COMMENT 'Stable prompt identity used for Harness submission and retry.',
    consumed_sequence BIGINT UNSIGNED COMMENT 'Sequence of the event confirming input consumption.',
    CONSTRAINT uk_ma_user_message_business_key UNIQUE (tenant_id, session_id, message_id),
    CONSTRAINT uk_ma_user_message_tenant_id UNIQUE (tenant_id, session_id, sequence_number),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_user_message_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Durable queued user inputs and their admission or consumption state.';

CREATE INDEX idx_ma_user_message_pending ON ma_user_message (state, tenant_id, session_id, sequence_number);

CREATE TABLE ma_user_message_command (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    command_key CHAR(64) NOT NULL COMMENT 'Digest of actor identity and idempotency key for a queue command.',
    actor_id VARBINARY(512) NOT NULL COMMENT 'Actor identity associated with this record.',
    request_digest CHAR(71) NOT NULL COMMENT 'Request digest used to reject conflicting retries.',
    result_json LONGTEXT NOT NULL COMMENT 'Serialized queue snapshot returned for this command and its retries.',
    CONSTRAINT uk_ma_user_message_command_business_key UNIQUE (tenant_id, session_id, command_key),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_user_message_command_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Idempotent receipts for input queue submit, edit, withdraw, and resume commands.';

CREATE TABLE ma_turn (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    turn_id VARBINARY(256) NOT NULL COMMENT 'Turn identity within the Session.',
    prompt_id VARBINARY(144) NOT NULL COMMENT 'Stable prompt identity used for Harness submission and retry.',
    input_json LONGTEXT NOT NULL COMMENT 'Serialized user input blocks.',
    payload_digest CHAR(71) NOT NULL COMMENT 'Digest of the admitted input payload used to validate prompt retries.',
    status VARCHAR(32) NOT NULL COMMENT 'Turn lifecycle status used for admission, dispatch, and settlement.',
    is_submission_attempted TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether submission to the Harness has been attempted.',
    harness_event_epoch VARBINARY(256) COMMENT 'Harness event epoch used to distinguish event stream incarnations.',
    harness_last_event_id BIGINT UNSIGNED COMMENT 'Last Harness event identifier observed in the recorded epoch.',
    dispatch_owner VARBINARY(512) COMMENT 'Worker currently claiming dispatch responsibility.',
    dispatch_lease_until BIGINT UNSIGNED COMMENT 'Dispatch claim expiry in Unix epoch milliseconds.',
    error_code VARCHAR(128) COMMENT 'Machine-readable error code.',
    error_message VARCHAR(2048) COMMENT 'Diagnostic error message.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    completed_at BIGINT UNSIGNED COMMENT 'Completion time in Unix epoch milliseconds.',
    version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Optimistic concurrency version of the record.',
    CONSTRAINT uk_ma_turn_business_key UNIQUE (tenant_id, session_id, turn_id),
    CONSTRAINT uk_ma_turn_prompt_id UNIQUE (prompt_id),
    retry_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of retries counted against the Turn retry budget.',
    consecutive_failures INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of consecutive dispatch failures.',
    budget_exempt_failures INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Failures tracked separately from the normal retry budget.',
    retry_after BIGINT UNSIGNED COMMENT 'Earliest retry time in Unix epoch milliseconds.',
    model_id VARBINARY(512) COMMENT 'Model identity frozen for this Turn.',
    model_revision BIGINT UNSIGNED COMMENT 'Model selection revision frozen for this Turn.',
    CONSTRAINT ck_ma_turn_model_selection CHECK ((model_id IS NULL AND model_revision IS NULL) OR (model_id IS NOT NULL AND model_revision IS NOT NULL AND model_revision >= 1 AND model_revision <= 9007199254740991)),
    approval_mode VARCHAR(32) COMMENT 'Approval mode frozen when this Turn was admitted.',
    approval_revision BIGINT UNSIGNED COMMENT 'Approval policy revision frozen when this Turn was admitted.',
    CONSTRAINT ck_ma_turn_approval_selection CHECK ((approval_mode IS NULL AND approval_revision IS NULL) OR (approval_mode IS NOT NULL AND approval_revision IS NOT NULL AND approval_revision >= 0 AND approval_revision <= 9007199254740991 AND (CASE approval_mode WHEN 'default' THEN 7 WHEN 'auto' THEN 4 WHEN 'auto-edit' THEN 9 WHEN 'yolo' THEN 4 ELSE -1 END = CHAR_LENGTH(approval_mode)))),
    is_plan_enabled TINYINT UNSIGNED COMMENT 'Plan-mode selection frozen for this Turn.',
    permission_rules_json LONGTEXT COMMENT 'Tool permission rules frozen for this Turn.',
    CONSTRAINT ck_ma_turn_permission_rules CHECK (permission_rules_json IS NULL OR (approval_mode IS NOT NULL AND approval_revision >= 1 AND OCTET_LENGTH(permission_rules_json) <= 8192)),
    CONSTRAINT ck_ma_turn_plan CHECK (is_plan_enabled IS NULL OR (approval_mode IS NOT NULL AND approval_revision IS NOT NULL AND (is_plan_enabled = 0 OR approval_revision >= 1))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_turn_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_turn_boolean_values CHECK ((is_submission_attempted >= 0 AND is_submission_attempted <= 1) AND (is_plan_enabled >= 0 AND is_plan_enabled <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Accepted user Turns, frozen execution options, and durable dispatch or retry state.';

CREATE INDEX idx_ma_turn_dispatch ON ma_turn (status, dispatch_lease_until, gmt_modified);

CREATE TABLE ma_session_head (
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Session identity used by the journal or Harness admission head.',
    storage_version INT UNSIGNED COMMENT 'Private Session storage protocol version.',
    state VARCHAR(32) COMMENT 'Private journal lifecycle state.',
    writer_generation BIGINT UNSIGNED COMMENT 'Writer generation fencing stale journal owners.',
    writer_id VARBINARY(2048) COMMENT 'Identity of the private Session journal writer.',
    writer_lease_until BIGINT UNSIGNED COMMENT 'Writer lease expiry in Unix epoch milliseconds.',
    lease_token_hash CHAR(64) COMMENT 'Hash of the credential authorizing the current journal writer.',
    journal_revision BIGINT UNSIGNED COMMENT 'Revision in the private Session transaction journal.',
    committed_sequence BIGINT UNSIGNED COMMENT 'Highest committed private journal event sequence.',
    last_commit_digest CHAR(64) COMMENT 'Digest of the latest committed transaction in the journal chain.',
    activation_epoch BIGINT UNSIGNED COMMENT 'Activation generation associated with the committed Session state.',
    latest_checkpoint_resource_id VARBINARY(2048) COMMENT 'Resource identity of the latest committed Session checkpoint.',
    compacted_through_revision BIGINT UNSIGNED COMMENT 'Highest journal revision covered by completed compaction.',
    recovery_status VARCHAR(32) COMMENT 'Current private Session recovery status.',
    recovery_detail_code VARCHAR(128) COMMENT 'Machine-readable detail for the recovery status.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    activation_id VARBINARY(2048) COMMENT 'Identity of the currently projected Session activation.',
    activation_phase VARCHAR(32) COMMENT 'Phase of the currently projected activation.',
    activation_event_epoch BIGINT UNSIGNED COMMENT 'Event epoch of the currently projected activation.',
    activation_expires_at BIGINT UNSIGNED COMMENT 'Activation lease expiry in Unix epoch milliseconds.',
    activation_head_revision BIGINT UNSIGNED COMMENT 'Journal revision through which the activation projection is current.',
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    harness_key CHAR(64) NOT NULL COMMENT 'Hashed Harness Session identity used in the head business key.',
    harness_session_id VARBINARY(2048) NOT NULL COMMENT 'Originating Harness Session identity.',
    head_kind VARCHAR(16) NOT NULL COMMENT 'MANAGED_SESSION for journal authority or HARNESS for admission control only.',
    phase VARCHAR(32) NOT NULL DEFAULT 'OPEN' COMMENT 'Harness admission or drain phase.',
    operation_id VARBINARY(512) COMMENT 'Stable operation identity.',
    claim_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic claim generation fencing stale workers.',
    claim_lease_until BIGINT UNSIGNED COMMENT 'Harness control claim expiry in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_session_head_business_key UNIQUE (tenant_key, harness_key),
    CONSTRAINT ck_ma_head_kind CHECK ((CASE head_kind WHEN 'MANAGED_SESSION' THEN 15 WHEN 'HARNESS' THEN 7 ELSE -1 END = CHAR_LENGTH(head_kind))),
    CONSTRAINT ck_ma_head_journal CHECK ((head_kind = 'HARNESS' AND journal_revision IS NULL AND committed_sequence IS NULL AND writer_generation IS NULL AND activation_epoch IS NULL AND storage_version IS NULL) OR (head_kind = 'MANAGED_SESSION' AND journal_revision IS NOT NULL AND committed_sequence IS NOT NULL AND writer_generation IS NOT NULL AND activation_epoch IS NOT NULL AND storage_version IS NOT NULL)),
    CONSTRAINT ck_ma_head_counters CHECK (claim_generation >= 0 AND (writer_generation IS NULL OR writer_generation >= 0) AND (activation_epoch IS NULL OR activation_epoch >= 0)),
    is_wake_pending TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether committed journal changes require a wake attempt.',
    wake_head_revision BIGINT UNSIGNED COMMENT 'Journal revision through which wake requirements have been evaluated.',
    wake_retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Earliest wake retry time in Unix epoch milliseconds.',
    is_wake_scan_pending TINYINT UNSIGNED GENERATED ALWAYS AS (is_wake_pending = 1 OR wake_head_revision IS NULL OR wake_head_revision <> journal_revision)
        COMMENT 'Generated flag for pending wake work or an outdated wake projection.',
    cleanup_head_revision BIGINT UNSIGNED COMMENT 'Journal revision through which cleanup requirements have been projected.',
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_session_head_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_session_head_boolean_values CHECK ((is_wake_pending >= 0 AND is_wake_pending <= 1) AND (is_wake_scan_pending >= 0 AND is_wake_scan_pending <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Private Session journal ownership and recovery head, or Harness-only admission control.';

CREATE INDEX idx_ma_head_workspace ON ma_session_head (tenant_key, workspace_id, harness_key);

CREATE TABLE ma_session_journal_tx (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    journal_revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision in the private Session transaction journal.',
    command_key_hash CHAR(64) NOT NULL COMMENT 'Digest of the operation and command identity for journal deduplication.',
    transaction_id VARBINARY(2048) NOT NULL COMMENT 'Stable identity of the committed journal transaction.',
    operation LONGTEXT NOT NULL COMMENT 'Private journal operation associated with the transaction.',
    command_id VARBINARY(2048) NOT NULL COMMENT 'Original command identity retained for replay and recovery.',
    content_digest CHAR(64) NOT NULL COMMENT 'Digest of the transaction command content.',
    first_sequence BIGINT UNSIGNED NOT NULL COMMENT 'First private event sequence committed by this transaction.',
    last_sequence BIGINT UNSIGNED NOT NULL COMMENT 'Last private event sequence committed by this transaction.',
    event_count INT UNSIGNED NOT NULL COMMENT 'Number of private events committed by this transaction.',
    events_digest CHAR(64) COMMENT 'Digest of the committed event payload.',
    previous_commit_digest CHAR(64) COMMENT 'Digest of the preceding transaction in the commit chain.',
    commit_digest CHAR(64) COMMENT 'Digest identifying this transaction in the commit chain.',
    writer_generation BIGINT UNSIGNED NOT NULL COMMENT 'Writer generation fencing stale journal owners.',
    writer_id VARBINARY(2048) NOT NULL COMMENT 'Identity of the private Session journal writer.',
    writer_token_hash CHAR(64) NOT NULL COMMENT 'Hash of the writer credential that authorized the commit.',
    activation_epoch BIGINT UNSIGNED NOT NULL COMMENT 'Activation generation associated with the committed Session state.',
    latest_checkpoint_resource_id VARBINARY(2048) COMMENT 'Resource identity of the latest committed Session checkpoint.',
    record_encoding VARCHAR(32) NOT NULL COMMENT 'Encoding of the stored transaction bytes.',
    record_bytes MEDIUMBLOB NOT NULL COMMENT 'Exact serialized transaction bytes used for replay and recovery.',
    byte_length BIGINT UNSIGNED NOT NULL COMMENT 'Length of the stored content in bytes.',
    record_digest CHAR(64) NOT NULL COMMENT 'Digest of the stored transaction bytes.',
    activation_lease_until BIGINT UNSIGNED COMMENT 'Latest activation lease expiry in Unix epoch milliseconds.',
    activation_renewal_seq BIGINT UNSIGNED COMMENT 'Monotonic activation lease renewal sequence.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_session_journal_tx_business_key UNIQUE (tenant_id, session_id, journal_revision),
    CONSTRAINT uk_managed_session_command
        UNIQUE (tenant_id, session_id, command_key_hash),
    CONSTRAINT ck_ma_activation_lease CHECK ((activation_lease_until IS NULL AND activation_renewal_seq IS NULL) OR (activation_lease_until IS NOT NULL AND activation_lease_until <= 9007199254740991 AND activation_renewal_seq IS NOT NULL AND activation_renewal_seq > 0 AND activation_renewal_seq <= 9007199254740991)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_session_journal_tx_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Committed private Session transactions, exact record bytes, and digest-chain evidence.';

CREATE TABLE ma_event_stream (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    stream_kind VARCHAR(16) NOT NULL COMMENT 'Event stream type: SESSION or TASK.',
    stream_id VARBINARY(512) NOT NULL COMMENT 'Task identity for TASK streams, or the empty identity for the Session stream.',
    last_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Durable tail sequence of the public event stream.',
    replay_floor_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Oldest accepted replay cursor after event retention.',
    covered_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Public event sequence covered by the materialized stream projection.',
    wake_covered_sequence BIGINT UNSIGNED COMMENT 'Private journal sequence already claimed for a wake attempt.',
    projection_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the projection format.',
    artifact_refs_resource_key CHAR(64) COMMENT 'Resource containing the projected artifact reference set.',
    output_ranges_json LONGTEXT COMMENT 'Serialized output ranges referenced by the stream projection.',
    is_projection_pending TINYINT UNSIGNED GENERATED ALWAYS AS (last_sequence > covered_sequence)
        COMMENT 'Generated flag indicating public events not yet covered by projection.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_event_stream_business_key UNIQUE (tenant_id, session_id, stream_kind, stream_id),
    CONSTRAINT ck_ma_stream_kind CHECK ((CASE stream_kind WHEN 'SESSION' THEN 7 WHEN 'TASK' THEN 4 ELSE -1 END = CHAR_LENGTH(stream_kind))),
    CONSTRAINT ck_ma_stream_counters CHECK (last_sequence >= 0 AND replay_floor_sequence >= 0 AND replay_floor_sequence <= last_sequence AND covered_sequence >= 0 AND covered_sequence <= last_sequence),
    CONSTRAINT ck_ma_stream_wake CHECK (wake_covered_sequence IS NULL OR (stream_kind = 'SESSION' AND wake_covered_sequence >= 0)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_event_stream_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_event_stream_boolean_values CHECK ((is_projection_pending >= 0 AND is_projection_pending <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Durable Session or Task event sequence, replay floor, and projection progress.';

CREATE INDEX idx_ma_stream_projection ON ma_event_stream (stream_kind, is_projection_pending, gmt_modified);

CREATE TABLE ma_public_event (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    sequence_id BIGINT UNSIGNED NOT NULL COMMENT 'Monotonic sequence within the Session or Task stream.',
    event_id VARBINARY(256) NOT NULL COMMENT 'Globally unique public event identity.',
    turn_id VARBINARY(256) COMMENT 'Turn identity within the Session.',
    event_type VARCHAR(128) NOT NULL COMMENT 'Public event type.',
    data_json LONGTEXT COMMENT 'Serialized public Session event payload.',
    is_terminal TINYINT UNSIGNED COMMENT 'Whether the Session event is terminal for its execution.',
    source_key VARBINARY(1024) COMMENT 'Source identity used to deduplicate events within a stream.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_public_event_business_key UNIQUE (tenant_id, session_id, stream_kind, stream_id, sequence_id),
    CONSTRAINT uk_ma_public_event_event_id UNIQUE (event_id),
    CONSTRAINT uk_ma_public_event_tenant_id UNIQUE (tenant_id, session_id, stream_kind, stream_id, source_key),
    schema_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the stored content schema.',
    projection_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the projection format.',
    item_id VARBINARY(512) COMMENT 'Public message Item identity.',
    content_part_id VARBINARY(512) COMMENT 'Content Part identity within the referenced message Item.',
    stream_kind VARCHAR(16) NOT NULL DEFAULT 'SESSION' COMMENT 'Event stream type: SESSION or TASK.',
    stream_id VARBINARY(512) NOT NULL DEFAULT '' COMMENT 'Identity of the stream within its scope.',
    state VARCHAR(32) COMMENT 'Projected Task state for Task stream events.',
    runtime_state VARCHAR(32) COMMENT 'Projected state of the associated Runtime execution.',
    text LONGTEXT COMMENT 'Projected text payload for a Task event.',
    is_truncated TINYINT UNSIGNED COMMENT 'Whether the projected text payload was truncated.',
    artifact_id VARBINARY(512) COMMENT 'Public artifact identity.',
    capture_id VARBINARY(512) COMMENT 'Tool output capture identity.',
    output_stream_id VARBINARY(512) COMMENT 'Tool output stream referenced by this event.',
    first_ordinal BIGINT UNSIGNED COMMENT 'First output chunk ordinal referenced by this event.',
    end_ordinal BIGINT UNSIGNED COMMENT 'End output chunk ordinal referenced by this event.',
    is_archived TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether this event has been archived.',
    CONSTRAINT ck_ma_event_session_payload CHECK (stream_kind = 'TASK' OR (data_json IS NOT NULL AND is_terminal IS NOT NULL)),
    CONSTRAINT ck_ma_event_stream CHECK ((CASE stream_kind WHEN 'SESSION' THEN 7 WHEN 'TASK' THEN 4 ELSE -1 END = CHAR_LENGTH(stream_kind))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_public_event_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_public_event_boolean_values CHECK ((is_terminal >= 0 AND is_terminal <= 1) AND (is_truncated >= 0 AND is_truncated <= 1) AND (is_archived >= 0 AND is_archived <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Public Session and Task events used for streaming, replay, and message projection.';

CREATE INDEX idx_ma_event_turn ON ma_public_event (tenant_id, session_id, turn_id, sequence_id);

CREATE TABLE ma_message (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    item_id VARBINARY(512) NOT NULL COMMENT 'Public message Item identity.',
    turn_id VARBINARY(256) NOT NULL COMMENT 'Turn identity within the Session.',
    item_type VARCHAR(32) NOT NULL COMMENT 'Public message Item type.',
    item_role VARCHAR(32) COMMENT 'Conversation role associated with the Item.',
    item_status VARCHAR(32) NOT NULL COMMENT 'Current projected status of the Item.',
    attributes_json LONGTEXT NOT NULL COMMENT 'Serialized Item attributes outside its content parts.',
    first_sequence BIGINT UNSIGNED NOT NULL COMMENT 'First public event sequence associated with the Item.',
    last_sequence BIGINT UNSIGNED NOT NULL COMMENT 'Latest public event sequence applied to the Item.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    revision BIGINT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Revision of the current message projection.',
    CONSTRAINT uk_ma_message_business_key UNIQUE (tenant_id, session_id, item_id),
    parts_json LONGTEXT NOT NULL COMMENT 'Ordered public content parts for the Item.',
    body_resource_key CHAR(64) COMMENT 'Resource containing an immutable message body when stored separately.',
    execution_key CHAR(64) COMMENT 'Hashed tool execution identity.',
    tool_call_key CHAR(64) COMMENT 'Hashed tool-call identity associated with this Item.',
    policy_version VARBINARY(512) COMMENT 'Version of the tool-result projection policy.',
    CONSTRAINT ck_ma_message_revision CHECK (revision > 0),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_message_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Current public message Items, ordered content parts, and tool-result references.';

CREATE INDEX idx_ma_message_history ON ma_message (tenant_id, session_id, first_sequence, item_id);

CREATE INDEX idx_ma_message_execution ON ma_message (execution_key, item_id);

CREATE TABLE ma_session_record (
    session_scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Session identity used to scope related records.',
    record_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the Session record.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    domain VARCHAR(64) NOT NULL COMMENT 'Typed domain such as child_run, mcp_configuration, hook_execution, or schedule.',
    record_id VARBINARY(2048) NOT NULL COMMENT 'Domain-specific Session record identity.',
    operation_hash CHAR(64) COMMENT 'Digest linking the record to its domain operation.',
    revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision of the stored record.',
    record_resource_id VARBINARY(2048) COMMENT 'Resource holding the serialized domain record.',
    task_kind VARCHAR(32) NULL COMMENT 'Projected Task kind for task-bearing domain records.',
    task_state VARCHAR(32) NULL COMMENT 'Projected Task lifecycle state.',
    runtime_state VARCHAR(32) COMMENT 'Projected state of the associated Runtime execution.',
    definition_revision BIGINT UNSIGNED COMMENT 'Revision of the associated immutable definition.',
    delivery_target VARCHAR(16) COMMENT 'Destination class for a projected message or result.',
    delivery_state VARCHAR(16) COMMENT 'State of delivery to the destination.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    started_at BIGINT UNSIGNED COMMENT 'Start time in Unix epoch milliseconds.',
    settled_at BIGINT UNSIGNED COMMENT 'Settlement time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_session_record_business_key UNIQUE (session_scope_key, record_key),
    first_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'First event sequence covered by this record.',
    hook_once_key_hash CHAR(64) NULL COMMENT 'Digest enforcing once-only Hook execution within a Session.',
    hook_occurrence_hash CHAR(64) NULL COMMENT 'Digest identifying a Hook occurrence.',
    hook_ordinal BIGINT UNSIGNED NULL COMMENT 'Hook execution ordinal within an occurrence.',
    hook_definition_hash CHAR(64) NULL  COMMENT 'Digest identifying the Hook definition.',
    record_kind VARCHAR(16) NOT NULL DEFAULT 'DOMAIN' COMMENT 'DOMAIN for private domain projections or ACTION for public approvals.',
    state VARCHAR(32) COMMENT 'Public approval Action state when record_kind is ACTION.',
    action_id VARBINARY(512) COMMENT 'Public approval Action identity.',
    action_version BIGINT UNSIGNED COMMENT 'Version of the approval Action being addressed.',
    decision_receipt_id VARBINARY(512) COMMENT 'Stable receipt identity for the accepted approval decision.',
    decision_digest CHAR(64) COMMENT 'Digest of the accepted approval decision.',
    prompt_id VARBINARY(512) COMMENT 'Stable prompt identity used for Harness submission and retry.',
    turn_id VARBINARY(512) COMMENT 'Turn identity within the Session.',
    options_json LONGTEXT COMMENT 'Serialized choices offered by a public approval Action.',
    CONSTRAINT ck_ma_record_kind CHECK ((CASE record_kind WHEN 'DOMAIN' THEN 6 WHEN 'ACTION' THEN 6 ELSE -1 END = CHAR_LENGTH(record_kind))),
    CONSTRAINT ck_ma_record_role CHECK ((record_kind = 'DOMAIN' AND workspace_id IS NOT NULL AND record_resource_id IS NOT NULL) OR (record_kind = 'ACTION' AND action_id IS NOT NULL AND action_version IS NOT NULL AND options_json IS NOT NULL)),
    CONSTRAINT uk_ma_action_identity UNIQUE (session_scope_key, action_id),
    CONSTRAINT uk_ma_hook_once UNIQUE (session_scope_key, hook_once_key_hash),
    CONSTRAINT uk_ma_hook_occurrence UNIQUE (session_scope_key, hook_occurrence_hash, hook_ordinal),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_session_record_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Latest typed Session domain projections and public approval Actions.';

CREATE INDEX idx_ma_record_task ON ma_session_record (session_scope_key, gmt_create, record_key);

CREATE INDEX idx_ma_record_action ON ma_session_record (session_scope_key, record_kind, state, gmt_create, action_id);

CREATE INDEX idx_ma_record_operation ON ma_session_record (session_scope_key, operation_hash);

CREATE INDEX idx_ma_record_domain ON ma_session_record (domain, gmt_create, record_id);

CREATE INDEX idx_ma_record_delivery ON ma_session_record (domain, delivery_state, gmt_create);

CREATE INDEX idx_ma_record_session_delivery ON ma_session_record (session_scope_key, domain, delivery_state, gmt_create, record_key);

CREATE TABLE ma_agent_definition (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    agent_id VARBINARY(512) NOT NULL COMMENT 'Agent definition identity within the tenant.',
    revision BIGINT UNSIGNED NOT NULL COMMENT 'Immutable revision of the Agent definition.',
    digest CHAR(64) NOT NULL COMMENT 'Digest of the serialized Agent definition.',
    definition_json LONGTEXT NOT NULL COMMENT 'Complete immutable Agent definition.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_agent_definition_business_key UNIQUE (tenant_id, agent_id, revision),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_agent_definition_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Immutable tenant-scoped Agent definition revisions pinned by Sessions.';

CREATE TABLE ma_resource (
    resource_key CHAR(64) NOT NULL COMMENT 'Hashed scoped resource identity.',
    session_scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Session identity used to scope related records.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    resource_id VARBINARY(2048) NOT NULL COMMENT 'Resource identity within the Session scope.',
    kind VARBINARY(2048) NOT NULL COMMENT 'Resource content kind selecting its validation and interpretation.',
    schema_version INT UNSIGNED NOT NULL COMMENT 'Version of the stored content schema.',
    byte_length BIGINT UNSIGNED NOT NULL COMMENT 'Length of the stored content in bytes.',
    sha256 CHAR(64) NOT NULL COMMENT 'SHA-256 digest of the complete resource body.',
    storage_kind VARCHAR(32) NOT NULL COMMENT 'Body storage mode, such as inline bytes or an external object.',
    inline_bytes LONGBLOB COMMENT 'Inline resource body when stored in SQL.',
    object_key VARBINARY(8192) COMMENT 'Object-store key locating the resource body.',
    object_version_id VARBINARY(2048) COMMENT 'Version identity of the external object.',
    encryption_key_id VARBINARY(2048) COMMENT 'Identifier of the key used to encrypt stored content.',
    publish_command_id VARBINARY(2048) COMMENT 'Command identity that published this resource.',
    state VARCHAR(32) NOT NULL COMMENT 'Resource publication, reference, or collection state.',
    scope_key CHAR(64) COMMENT 'Tool publication scope when this resource occupies a capture slot.',
    publication_id VARBINARY(512) COMMENT 'Tool output publication identity.',
    slot_key VARBINARY(1024) COMMENT 'Object slot within a tool output publication.',
    capture_state VARCHAR(32) COMMENT 'Capture object verification or quarantine state.',
    capture_object_key VARBINARY(4096) COMMENT 'Object-store key used by the output capture protocol.',
    operation_id VARBINARY(512) COMMENT 'Operation identity associated with the capture object.',
    quarantine_reason VARCHAR(128) COMMENT 'Reason this resource was quarantined.',
    deletion_operation_key CHAR(64) COMMENT 'Durable operation that owns the resource deletion intent.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    last_verified_at BIGINT UNSIGNED COMMENT 'Last integrity verification time in Unix epoch milliseconds.',
    retention_until BIGINT UNSIGNED COMMENT 'Earliest retention expiry in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_resource_business_key UNIQUE (resource_key),
    CONSTRAINT uk_ma_resource_id UNIQUE (session_scope_key, resource_id),
    CONSTRAINT uk_ma_capture_slot UNIQUE (scope_key, publication_id, slot_key),
    CONSTRAINT ck_ma_resource_length CHECK (byte_length >= 0),
    CONSTRAINT ck_ma_resource_capture CHECK ((publication_id IS NULL AND scope_key IS NULL AND slot_key IS NULL AND capture_state IS NULL) OR (publication_id IS NOT NULL AND scope_key IS NOT NULL AND slot_key IS NOT NULL AND capture_state IS NOT NULL)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_resource_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Scoped resource bodies or object references, integrity metadata, and collection state.';

CREATE INDEX idx_ma_resource_gc ON ma_resource (session_scope_key, state, retention_until, resource_key);

CREATE INDEX idx_ma_resource_projection_gc ON ma_resource (retention_until, resource_key);

CREATE INDEX idx_ma_resource_capture ON ma_resource (scope_key, publication_id, capture_state);

CREATE INDEX idx_ma_resource_delete_intent ON ma_resource (session_scope_key, state, deletion_operation_key, resource_key);

CREATE TABLE ma_resource_ref (
    session_scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Session identity used to scope related records.',
    owner_kind VARCHAR(32) NOT NULL COMMENT 'Typed resource owner, such as JOURNAL, NATIVE_SNAPSHOT, MESSAGE, or OPERATION.',
    owner_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the owning record.',
    owner_revision BIGINT UNSIGNED NOT NULL COMMENT 'Owning record revision that retains this resource.',
    resource_key CHAR(64) NOT NULL COMMENT 'Hashed scoped resource identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    journal_revision BIGINT UNSIGNED COMMENT 'Journal revision associated with this reference when applicable.',
    resource_id VARBINARY(2048) COMMENT 'Resource identity within the Session scope.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_resource_ref_business_key UNIQUE (session_scope_key, owner_kind, owner_key, owner_revision, resource_key),
    CONSTRAINT ck_ma_ref_owner CHECK ((CASE owner_kind WHEN 'JOURNAL' THEN 7 WHEN 'NATIVE_SNAPSHOT' THEN 15 WHEN 'CAPTURE' THEN 7 WHEN 'ARTIFACT' THEN 8 WHEN 'MESSAGE' THEN 7 WHEN 'SESSION_RECORD' THEN 14 WHEN 'EVENT_STREAM' THEN 12 WHEN 'OPERATION' THEN 9 WHEN 'OPERATION_WORK' THEN 14 WHEN 'RECOVERY' THEN 8 WHEN 'HOSTED_CLEANUP' THEN 14 ELSE -1 END = CHAR_LENGTH(owner_kind))),
    runtime_binding_key CHAR(64) COMMENT 'Runtime binding key required for HOSTED_CLEANUP references.',
    CONSTRAINT ck_ma_ref_binding CHECK ((owner_kind = 'HOSTED_CLEANUP' AND runtime_binding_key IS NOT NULL AND owner_revision > 0) OR (owner_kind <> 'HOSTED_CLEANUP' AND runtime_binding_key IS NULL)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_resource_ref_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Typed owner-to-resource references that protect resources from premature collection.';

CREATE INDEX idx_ma_ref_resource ON ma_resource_ref (resource_key, session_scope_key);

CREATE INDEX idx_ma_ref_journal ON ma_resource_ref (session_scope_key, journal_revision, resource_id);

CREATE TABLE ma_output_capture (
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant, Workspace, and Session publication scope.',
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    publication_id VARBINARY(512) NOT NULL COMMENT 'Tool output publication identity.',
    execution_key CHAR(64) NOT NULL COMMENT 'Hashed tool execution identity.',
    capture_id VARBINARY(512) NOT NULL COMMENT 'Tool output capture identity.',
    binding_json MEDIUMTEXT NOT NULL COMMENT 'Serialized immutable tool output binding.',
    binding_digest CHAR(64) NOT NULL COMMENT 'Digest of the serialized output binding.',
    token_hash CHAR(64) NOT NULL COMMENT 'Hash of the credential authorizing the operation.',
    state VARCHAR(32) NOT NULL COMMENT 'Capture lifecycle state.',
    expires_at BIGINT UNSIGNED COMMENT 'Expiry time in Unix epoch milliseconds.',
    capture_bytes BIGINT UNSIGNED NOT NULL COMMENT 'Admitted byte budget for captured output.',
    producer_bytes BIGINT UNSIGNED NOT NULL COMMENT 'Admitted byte budget for producer completion evidence.',
    admission_bytes BIGINT UNSIGNED NOT NULL COMMENT 'Admitted byte budget for journal-admission evidence.',
    CONSTRAINT uk_ma_output_capture_business_key UNIQUE (scope_key, publication_id),
    CONSTRAINT uk_tool_publication_execution UNIQUE (scope_key, execution_key),
    CONSTRAINT uk_tool_publication_capture UNIQUE (scope_key, capture_id),
    producer_phase VARCHAR(32) NOT NULL DEFAULT 'OPEN' COMMENT 'Producer progress through output completion and journal admission.',
    is_quarantined TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether the publication is quarantined.',
    active_operation_id VARBINARY(512) COMMENT 'Currently active publication mutation.',
    finish_operation_id VARBINARY(512) COMMENT 'Operation identity used to finish this publication.',
    finish_predecessor_id VARBINARY(512) COMMENT 'Predecessor identity required by the finish operation.',
    finish_digest CHAR(64) COMMENT 'Digest of the accepted finish request.',
    terminal_resource_id VARBINARY(512) COMMENT 'Resource containing the terminal producer record.',
    admission_resource_id VARBINARY(512) COMMENT 'Resource containing journal-admission evidence.',
    receipt_sequence BIGINT UNSIGNED COMMENT 'Committed journal sequence of the publication admission receipt.',
    receipt_revision BIGINT UNSIGNED COMMENT 'Committed journal revision of the publication admission receipt.',
    capture_held_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Capture capacity currently reserved in bytes.',
    producer_held_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Producer evidence capacity currently reserved in bytes.',
    admission_held_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Admission evidence capacity currently reserved in bytes.',
    capture_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Capture capacity consumed in bytes.',
    producer_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Producer evidence capacity consumed in bytes.',
    admission_used_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Admission evidence capacity consumed in bytes.',
    retention_state VARCHAR(32) NOT NULL DEFAULT 'PINNED' COMMENT 'Retention or collection state of the publication.',
    is_write_evidence TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether this publication uses durable object-write evidence.',
    is_accepted_complete TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether a complete terminal publication was admitted into the Session journal.',
    collected_at BIGINT UNSIGNED COMMENT 'Collection completion time in Unix epoch milliseconds.',
    collected_bytes BIGINT UNSIGNED COMMENT 'Bytes accounted as collected by retention.',
    released_held_bytes BIGINT UNSIGNED  COMMENT 'Reserved byte capacity released by collection.',
    manifest_resource_key CHAR(64) COMMENT 'Resource containing the capture manifest.',
    manifest_sha256 CHAR(64) COMMENT 'SHA-256 digest of the capture manifest.',
    seal_manifest_resource_key CHAR(64) COMMENT 'Resource containing the sealed output manifest.',
    seal_manifest_sha256 CHAR(64) COMMENT 'SHA-256 digest of the sealed output manifest.',
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT (CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000 + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000)) COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT (CAST(UNIX_TIMESTAMP() AS DECIMAL(20, 0)) * 1000 + FLOOR(EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) / 1000)) COMMENT 'Last record update time in Unix epoch milliseconds.',
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_output_capture_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_output_capture_boolean_values CHECK ((is_quarantined >= 0 AND is_quarantined <= 1) AND (is_write_evidence >= 0 AND is_write_evidence <= 1) AND (is_accepted_complete >= 0 AND is_accepted_complete <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Tool output capture, publication admission, capacity accounting, and retention state.';

CREATE INDEX idx_ma_capture_tenant ON ma_output_capture (tenant_key, state);

CREATE INDEX idx_ma_capture_retention ON ma_output_capture (retention_state);

CREATE INDEX idx_ma_capture_delete_intent ON ma_output_capture (scope_key, retention_state, publication_id);

CREATE INDEX idx_ma_capture_admission ON ma_output_capture (scope_key, admission_resource_id);

CREATE INDEX idx_ma_capture_session ON ma_output_capture (tenant_id, session_id);

CREATE TABLE ma_artifact (
    artifact_id VARBINARY(320) NOT NULL COMMENT 'Public artifact identity.',
    result_id VARBINARY(320) NOT NULL COMMENT 'Tool result identity that exposes the artifact.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed scope identity used to partition records.',
    descriptor_json MEDIUMTEXT NOT NULL COMMENT 'Public artifact descriptor.',
    publication_id VARBINARY(512) NOT NULL COMMENT 'Tool output publication identity.',
    binding_json MEDIUMTEXT NOT NULL COMMENT 'Serialized immutable tool output binding.',
    manifest_ref_json MEDIUMTEXT NOT NULL COMMENT 'Reference to the immutable output manifest.',
    stream_id VARBINARY(512) NOT NULL COMMENT 'Output stream exposed by this artifact.',
    creation_sequence BIGINT UNSIGNED NOT NULL COMMENT 'Sequence used for stable artifact listing order.',
    CONSTRAINT uk_managed_artifact_stream UNIQUE (result_id, stream_id),
    CONSTRAINT uk_ma_artifact_business_key UNIQUE (artifact_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_artifact_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Public artifact descriptors and their published output stream references.';

CREATE INDEX idx_ma_artifact_page ON ma_artifact (scope_key, creation_sequence, artifact_id);

CREATE TABLE ma_request_receipt (
    receipt_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the scoped idempotency receipt.',
    namespace VARCHAR(32) NOT NULL COMMENT 'Closed command namespace used to separate idempotency domains.',
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    scope_kind VARCHAR(16) NOT NULL COMMENT 'Request scope type: TENANT, ACTOR, SESSION, or CHANNEL.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed scope identity used to partition records.',
    scope_id VARBINARY(2732) NOT NULL COMMENT 'Original identity of the request scope.',
    idempotency_key VARBINARY(2048) NOT NULL COMMENT 'Original key identifying retries of the same request.',
    idempotency_digest CHAR(64) NOT NULL COMMENT 'Digest of the idempotency key used in unique indexes.',
    request_digest VARCHAR(80) NOT NULL COMMENT 'Request digest used to reject conflicting retries.',
    actor_id VARBINARY(2048) COMMENT 'Actor identity associated with this record.',
    operation VARCHAR(64) COMMENT 'Command operation associated with this receipt.',
    state VARCHAR(32) NOT NULL COMMENT 'Admission or settlement state of the request.',
    is_workspace_bound TINYINT UNSIGNED COMMENT 'Whether the Session creation request binds a Workspace.',
    session_id VARBINARY(512) COMMENT 'Managed Session identity.',
    turn_id VARBINARY(512) COMMENT 'Turn identity within the Session.',
    agent_id VARBINARY(512) COMMENT 'Agent definition identity associated with the request.',
    agent_revision BIGINT UNSIGNED COMMENT 'Agent definition revision associated with the request.',
    schedule_id VARBINARY(512) COMMENT 'Automation schedule identity within the tenant.',
    channel_id VARBINARY(512) COMMENT 'External channel instance identity within the tenant.',
    account_generation BIGINT UNSIGNED COMMENT 'Channel account generation fencing earlier account bindings.',
    semantic_revision BIGINT UNSIGNED COMMENT 'Channel ingress semantics revision included in deduplication.',
    action_id VARBINARY(512) COMMENT 'Public approval Action identity.',
    action_version BIGINT UNSIGNED COMMENT 'Version of the approval Action being addressed.',
    decision_scope_key CHAR(64) GENERATED ALWAYS AS (CASE WHEN namespace = 'ACTION_DECISION' THEN RTRIM(scope_key) ELSE NULL END)
        COMMENT 'Generated approval decision scope enforcing a single accepted decision.',
    mutation_attempt_sequence BIGINT UNSIGNED COMMENT 'Sequence identifying the admitted mutation attempt.',
    session_status_before VARCHAR(32) COMMENT 'Session status captured before the mutation.',
    result_operation_key CHAR(64) COMMENT 'Durable operation associated with the accepted request.',
    result_json LONGTEXT COMMENT 'Serialized durable result returned on completion or replay.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_request_receipt_business_key UNIQUE (receipt_key),
    CONSTRAINT uk_ma_decision_slot UNIQUE (tenant_key, decision_scope_key),
    CONSTRAINT uk_ma_request UNIQUE (namespace, tenant_key, scope_key, idempotency_digest),
    CONSTRAINT ck_ma_request_namespace CHECK ((CASE namespace WHEN 'SESSION_COMMAND' THEN 15 WHEN 'SESSION_CREATE_MODE' THEN 19 WHEN 'SESSION_CREATE_ACTOR' THEN 20 WHEN 'AGENT_DEFINITION' THEN 16 WHEN 'AUTOMATION' THEN 10 WHEN 'CHANNEL_INGRESS' THEN 15 WHEN 'ACTION_DECISION' THEN 15 WHEN 'WORKSPACE_CREATE' THEN 16 WHEN 'EXTERNAL_STORAGE' THEN 16 ELSE -1 END = CHAR_LENGTH(namespace))),
    CONSTRAINT ck_ma_request_scope CHECK ((CASE scope_kind WHEN 'TENANT' THEN 6 WHEN 'ACTOR' THEN 5 WHEN 'SESSION' THEN 7 WHEN 'CHANNEL' THEN 7 ELSE -1 END = CHAR_LENGTH(scope_kind))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_request_receipt_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_request_receipt_boolean_values CHECK ((is_workspace_bound >= 0 AND is_workspace_bound <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Scoped idempotency receipts for commands, creation, approvals, and external ingress.';

CREATE INDEX idx_ma_receipt_session ON ma_request_receipt (namespace, tenant_key, session_id);

CREATE INDEX idx_ma_receipt_channel ON ma_request_receipt (namespace, channel_id, account_generation, semantic_revision);

-- Turn input and cancellation commands are durable operations (D7-1).
CREATE TABLE ma_operation (
    operation_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the durable operation.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed scope identity used to partition records.',
    session_scope_key CHAR(64) COMMENT 'Hashed tenant and Session identity used to scope related records.',
    operation_id VARBINARY(2048) NOT NULL COMMENT 'Stable operation identity.',
    operation_kind VARCHAR(48) NOT NULL COMMENT 'Operation type selecting its lifecycle and processing rules.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(2048) COMMENT 'Managed Session identity.',
    workspace_id VARBINARY(2048) COMMENT 'Workspace identity within the tenant.',
    target_kind VARCHAR(32) NOT NULL COMMENT 'Type of resource or entity targeted by the operation.',
    target_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the operation target.',
    target_revision BIGINT UNSIGNED COMMENT 'Target revision captured by the operation.',
    target_id VARBINARY(2048) COMMENT 'Original identity of the operation target.',
    storage_key CHAR(64) COMMENT 'Storage identity key used for indexed lookup and coordination.',
    physical_key CHAR(64) COMMENT 'Canonical physical storage identity shared by logical aliases.',
    actor_key VARBINARY(2048) COMMENT 'Encoded actor identity used for authorization and idempotency.',
    actor_id VARBINARY(2048) COMMENT 'Actor identity associated with this record.',
    idempotency_key VARBINARY(2048) COMMENT 'Original key identifying retries of the same request.',
    idempotency_digest CHAR(64) COMMENT 'Digest of the idempotency key used in unique indexes.',
    request_digest VARCHAR(80) NOT NULL COMMENT 'Request digest used to reject conflicting retries.',
    actor_digest VARCHAR(80) COMMENT 'Digest of the initiating actor identity for request uniqueness.',
    lifecycle_protocol_version INT UNSIGNED COMMENT 'Harness lifecycle protocol version pinned by the operation.',
    lifecycle_effects_receipt_json LONGTEXT COMMENT 'Durable receipt describing completed lifecycle side effects.',
    action_id VARBINARY(512) COMMENT 'Public approval Action identity.',
    task_id VARBINARY(2048) COMMENT 'Task identity targeted by cancellation or lifecycle work.',
    decision_receipt_id VARBINARY(512) COMMENT 'Stable receipt identity for the accepted approval decision.',
    target_cwd_relative VARCHAR(2048) COMMENT 'Requested working directory relative to the Workspace root.',
    expected_context_revision BIGINT UNSIGNED COMMENT 'Context revision required when admitting a directory change.',
    result_context_revision BIGINT UNSIGNED COMMENT 'Context revision produced by the completed directory change.',
    payload_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the serialized payload format.',
    request_json LONGTEXT NOT NULL COMMENT 'Serialized operation request.',
    result_json LONGTEXT COMMENT 'Serialized durable result returned on completion or replay.',
    state VARCHAR(32) NOT NULL COMMENT 'Lifecycle state of this record.',
    phase VARCHAR(48) NOT NULL COMMENT 'Current processing phase.',
    admission_stage VARCHAR(32) COMMENT 'Progress of operation admission across control-plane boundaries.',
    delivery_state VARCHAR(32) COMMENT 'State of delivery to the destination.',
    session_status_before VARCHAR(32) COMMENT 'Session status captured before the mutation.',
    receipt_id VARBINARY(512) COMMENT 'Receipt identity returned by the operation protocol.',
    claim_owner VARBINARY(512) COMMENT 'Worker identity holding the current processing claim.',
    claim_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic claim generation fencing stale workers.',
    claim_until BIGINT UNSIGNED COMMENT 'Processing claim expiry in Unix epoch milliseconds.',
    available_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Earliest processing time in Unix epoch milliseconds.',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of processing attempts.',
    budget_exempt_attempt INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Attempts excluded from the ordinary retry budget.',
    deadline BIGINT UNSIGNED COMMENT 'Operation deadline in Unix epoch milliseconds.',
    recovery_deadline BIGINT UNSIGNED COMMENT 'Recovery deadline in Unix epoch milliseconds.',
    execution_mode VARCHAR(16) NOT NULL DEFAULT 'SYNC' COMMENT 'Synchronous or asynchronous execution mode.',
    verification_request_json LONGTEXT COMMENT 'Frozen request used for asynchronous output verification.',
    is_verification_ready TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether asynchronous verification can be attempted.',
    verification_next_at BIGINT UNSIGNED COMMENT 'Earliest verification attempt time in Unix epoch milliseconds.',
    publication_id VARBINARY(512) COMMENT 'Tool output publication identity.',
    publication_command_id VARBINARY(2048) GENERATED ALWAYS AS (CASE operation_kind WHEN 'OUTPUT_UPLOAD' THEN operation_id WHEN 'OUTPUT_VERIFY' THEN operation_id WHEN 'OUTPUT_FINISH' THEN operation_id ELSE NULL END)
        COMMENT 'Generated command identity enforcing uniqueness within an output publication.',
    slot_key VARBINARY(1024) COMMENT 'Output publication object slot targeted by the operation.',
    execution_key CHAR(64) COMMENT 'Hashed tool execution identity.',
    item_id VARBINARY(512) COMMENT 'Public message Item identity.',
    policy_version VARBINARY(512) COMMENT 'Version of the tool-result projection policy.',
    failure_status INT UNSIGNED COMMENT 'HTTP failure status retained for response replay.',
    failure_code VARCHAR(128) COMMENT 'Machine-readable failure code.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    completed_at BIGINT UNSIGNED COMMENT 'Completion time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_operation_business_key UNIQUE (operation_key),
    CONSTRAINT uk_ma_operation_identity UNIQUE (scope_key, operation_kind, target_key, operation_id),
    CONSTRAINT uk_ma_publication_operation UNIQUE (scope_key, publication_id, publication_command_id),
    CONSTRAINT uk_ma_operation_public_request UNIQUE (scope_key, operation_kind, target_key, actor_digest, idempotency_digest),
    CONSTRAINT uk_ma_operation_request UNIQUE (scope_key, operation_kind, target_key, actor_key, idempotency_digest),
    CONSTRAINT ck_ma_operation_generation CHECK (claim_generation >= 0 AND attempt_count >= 0 AND payload_version > 0),
    CONSTRAINT ck_ma_operation_mode CHECK ((CASE execution_mode WHEN 'SYNC' THEN 4 WHEN 'ASYNC' THEN 5 ELSE -1 END = CHAR_LENGTH(execution_mode))),
    CONSTRAINT ck_ma_operation_kind CHECK ((CASE operation_kind WHEN 'CLOSE' THEN 5 WHEN 'ARCHIVE' THEN 7 WHEN 'DELETE' THEN 6 WHEN 'UNARCHIVE' THEN 9 WHEN 'RENAME' THEN 6 WHEN 'CWD_CHANGE' THEN 10 WHEN 'CONTEXT_COMPRESSION' THEN 19 WHEN 'ACTION_RESPONSE' THEN 15 WHEN 'TASK_CANCEL' THEN 11 WHEN 'CHILD_SESSION_START' THEN 19 WHEN 'CHILD_SESSION_CLOSE' THEN 19 WHEN 'CHILD_WORKSPACE' THEN 15 WHEN 'SESSION_WORKTREE' THEN 16 WHEN 'OUTPUT_UPLOAD' THEN 13 WHEN 'OUTPUT_VERIFY' THEN 13 WHEN 'OUTPUT_FINISH' THEN 13 WHEN 'OBJECT_PUT' THEN 10 WHEN 'TOOL_RESULT_PROJECTION' THEN 22 WHEN 'SESSION_RESOURCE_GC' THEN 19 WHEN 'CAPTURE_GC' THEN 10 WHEN 'WORKSPACE_OPERATOR_RECOVERY' THEN 27 WHEN 'WORKSPACE_RECOVERY' THEN 18 WHEN 'STORAGE_MIGRATION' THEN 17 WHEN 'CSI_RETIREMENT' THEN 14 WHEN 'CHANNEL_INGRESS' THEN 15 WHEN 'WORKSPACE_CREATE' THEN 16 WHEN 'SUBMIT_INPUT' THEN 12 WHEN 'CANCEL' THEN 6 WHEN 'WORKSPACE_RETIREMENT' THEN 20 WHEN 'WORKSPACE_UPLOAD' THEN 16 ELSE -1 END = CHAR_LENGTH(operation_kind))),
    progress_format VARCHAR(64) COMMENT 'Format identifier for durable settlement progress.',
    progress_version BIGINT UNSIGNED COMMENT 'Monotonic version of the durable settlement progress.',
    progress_stage VARCHAR(16) COMMENT 'Current durable settlement stage.',
    settlement_deadline_ms BIGINT UNSIGNED COMMENT 'Settlement deadline in Unix epoch milliseconds.',
    frozen_request_bytes LONGBLOB COMMENT 'Exact frozen settlement request bytes.',
    frozen_request_sha256 CHAR(64) COMMENT 'SHA-256 digest of the frozen settlement request.',
    cut_bytes LONGBLOB COMMENT 'Exact bytes of the frozen settlement inventory.',
    cut_sha256 CHAR(64) COMMENT 'SHA-256 digest of the frozen settlement inventory.',
    finalize_receipt_bytes LONGBLOB COMMENT 'Exact bytes of the final settlement receipt.',
    finalize_receipt_sha256 CHAR(64) COMMENT 'SHA-256 digest of the final settlement receipt.',
    -- RTRIM avoids MariaDB's PAD_CHAR_TO_FULL_LENGTH dependency in this indexed generated column.
    csi_retirement_target_key CHAR(64) GENERATED ALWAYS AS (CASE WHEN operation_kind = 'CSI_RETIREMENT' THEN RTRIM(target_key) ELSE NULL END)
        COMMENT 'Generated target key enforcing one CSI retirement per target revision.',
    CONSTRAINT uk_ma_csi_retirement_target UNIQUE (csi_retirement_target_key, target_revision),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_operation_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_operation_boolean_values CHECK ((is_verification_ready >= 0 AND is_verification_ready <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Durable lifecycle, publication, recovery, and other operations with fenced worker claims.';

CREATE INDEX idx_ma_operation_due ON ma_operation (operation_kind, delivery_state, available_at);

CREATE INDEX idx_ma_operation_claim ON ma_operation (operation_kind, state, claim_until);

CREATE INDEX idx_ma_operation_target ON ma_operation (operation_kind, target_key, target_revision, state);

CREATE INDEX idx_ma_operation_storage ON ma_operation (storage_key, operation_kind, state);

CREATE INDEX idx_ma_operation_physical ON ma_operation (physical_key, operation_kind, state);

CREATE INDEX idx_ma_operation_verification ON ma_operation (operation_kind, execution_mode, state, is_verification_ready, verification_next_at);

CREATE INDEX idx_ma_operation_publication ON ma_operation (scope_key, publication_id, operation_kind, state);

CREATE INDEX idx_ma_operation_execution ON ma_operation (scope_key, operation_kind, execution_key);

CREATE INDEX idx_ma_operation_item ON ma_operation (scope_key, operation_kind, item_id);

CREATE TABLE ma_operation_work (
    operation_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the durable operation.',
    work_kind VARCHAR(32) NOT NULL COMMENT 'Typed work target, such as SESSION, RESOURCE, or CSI_WORKER_ACK.',
    target_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the operation target.',
    target_id VARBINARY(2048) NOT NULL COMMENT 'Original identity of the operation target.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) COMMENT 'Managed Session identity.',
    storage_key CHAR(64) COMMENT 'Storage identity key used for indexed lookup and coordination.',
    physical_key CHAR(64) COMMENT 'Canonical physical storage identity shared by logical aliases.',
    state VARCHAR(32) NOT NULL COMMENT 'Processing state of this operation target.',
    revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of the stored record.',
    payload_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the serialized payload format.',
    payload_json LONGTEXT NOT NULL COMMENT 'Serialized work or delivery payload.',
    evidence_resource_key CHAR(64) COMMENT 'Resource containing immutable completion or recovery evidence.',
    evidence_sha256 CHAR(64) COMMENT 'SHA-256 digest of the referenced evidence.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_operation_work_business_key UNIQUE (operation_key, work_kind, target_key),
    CONSTRAINT ck_ma_work_kind CHECK ((CASE work_kind WHEN 'SESSION' THEN 7 WHEN 'RESOURCE' THEN 8 WHEN 'EXECUTION_ACK' THEN 13 WHEN 'RUNTIME_BINDING' THEN 15 WHEN 'CSI_WORKER_ACK' THEN 14 WHEN 'RECOVERY_EVIDENCE' THEN 17 WHEN 'POD_DELETE_ATTEMPT' THEN 18 WHEN 'POD_FINALIZER_ATTEMPT' THEN 21 ELSE -1 END = CHAR_LENGTH(work_kind))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_operation_work_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Per-target progress and evidence for a durable multi-target operation.';

CREATE INDEX idx_ma_work_session ON ma_operation_work (tenant_id, session_id, work_kind, state);

CREATE INDEX idx_ma_work_storage ON ma_operation_work (storage_key, work_kind, state);

CREATE INDEX idx_ma_work_physical ON ma_operation_work (physical_key, work_kind, state);

CREATE INDEX idx_ma_work_evidence ON ma_operation_work (evidence_resource_key);

CREATE TABLE ma_workspace (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    workspace_generation BIGINT UNSIGNED NOT NULL COMMENT 'Current generation of the registered Workspace.',
    storage_id VARBINARY(1024) NOT NULL COMMENT 'Logical storage identity.',
    display_name VARCHAR(512) NOT NULL COMMENT 'User-visible Workspace name.',
    config_ref VARBINARY(2048) NOT NULL COMMENT 'Reference to the Workspace execution configuration.',
    policy_ref VARBINARY(2048) NOT NULL COMMENT 'Reference to the Workspace execution policy.',
    state VARCHAR(16) NOT NULL COMMENT 'Workspace lifecycle state: ACTIVE, DRAINING, or REMOVED.',
    CONSTRAINT uk_ma_workspace_business_key UNIQUE (tenant_id, workspace_id),
    CONSTRAINT ck_ma_workspace_generation CHECK (workspace_generation > 0),
    CONSTRAINT ck_ma_workspace_state CHECK ((CASE state WHEN 'ACTIVE' THEN 6 WHEN 'DRAINING' THEN 8 WHEN 'REMOVED' THEN 7 ELSE -1 END = CHAR_LENGTH(state))),
    workspace_kind VARCHAR(16) NOT NULL DEFAULT 'ROOT' COMMENT 'ROOT for a registered Workspace or CHILD_GIT for a child Git Workspace.',
    child_state VARCHAR(32) COMMENT 'Preparation, merge, discard, or failure state of a child Workspace.',
    parent_workspace_id VARBINARY(512) COMMENT 'Parent Workspace identity for CHILD_GIT entries.',
    parent_session_id VARBINARY(512) COMMENT 'Parent Session that owns the child Workspace operation.',
    child_run_id VARBINARY(2048) COMMENT 'Child-run identity that requested this Workspace.',
    child_workspace_id VARBINARY(128) COMMENT 'Stable public identity of the child Workspace.',
    parent_cwd_relative VARCHAR(2048) COMMENT 'Parent working directory relative to the root Workspace.',
    repository_relative VARCHAR(2048) COMMENT 'Repository path relative to the Workspace root.',
    child_cwd_relative VARCHAR(2048) COMMENT 'Child working directory relative to the Workspace root.',
    base_commit VARCHAR(64) COMMENT 'Git commit from which the child Workspace was created.',
    result_commit VARCHAR(64) COMMENT 'Git commit containing the completed child changes.',
    parent_tree VARCHAR(64) COMMENT 'Parent Git tree captured for merge validation.',
    merged_tree VARCHAR(64) COMMENT 'Git tree produced by the child merge.',
    finish_request VARCHAR(16) COMMENT 'Requested child Workspace completion action.',
    outcome_code VARCHAR(64) COMMENT 'Machine-readable child Workspace completion outcome.',
    conflict_paths LONGTEXT COMMENT 'Serialized paths involved in a child Workspace merge conflict.',
    last_error VARCHAR(1024) COMMENT 'Most recent diagnostic failure message.',
    is_default TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether this is the default root Workspace for the tenant.',
    default_tenant VARBINARY(512) GENERATED ALWAYS AS (CASE WHEN is_default THEN tenant_id ELSE NULL END)
        COMMENT 'Generated tenant identity enforcing at most one default Workspace.',
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_workspace_default UNIQUE (default_tenant),
    CONSTRAINT uk_ma_workspace_child UNIQUE (tenant_id, parent_session_id, child_run_id),
    CONSTRAINT uk_ma_child_workspace_id UNIQUE (child_workspace_id),
    CONSTRAINT ck_ma_workspace_kind CHECK ((CASE workspace_kind WHEN 'ROOT' THEN 4 WHEN 'CHILD_GIT' THEN 9 ELSE -1 END = CHAR_LENGTH(workspace_kind))),
    CONSTRAINT ck_ma_workspace_default CHECK (is_default = 0 OR workspace_kind = 'ROOT'),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_workspace_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_workspace_boolean_values CHECK ((is_default >= 0 AND is_default <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Root and child Git Workspaces, storage bindings, lifecycle, and default selection.';

CREATE INDEX idx_ma_workspace_storage ON ma_workspace (tenant_id, storage_id, state);

CREATE TABLE ma_workspace_access (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    actor_id VARBINARY(2048) NOT NULL COMMENT 'Encoded tenant and actor identity receiving this Workspace grant.',
    CONSTRAINT uk_ma_workspace_access_business_key UNIQUE (tenant_id, workspace_id, actor_id),
    role VARCHAR(16) NOT NULL COMMENT 'Workspace access role: READER, OPERATOR, or OWNER.',
    CONSTRAINT ck_ma_access_role CHECK (CASE role WHEN 'READER' THEN 6 WHEN 'OPERATOR' THEN 8 WHEN 'OWNER' THEN 5 ELSE -1 END = CHAR_LENGTH(role)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_workspace_access_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Per-actor Workspace grants with READER, OPERATOR, or OWNER access.';

CREATE TABLE ma_extension_package (
    package_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the scoped extension package revision.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Workspace identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    extension_id VARBINARY(128) NOT NULL COMMENT 'Workspace extension identity.',
    package_revision BIGINT UNSIGNED NOT NULL COMMENT 'Immutable extension package revision.',
    package_digest CHAR(64) NOT NULL COMMENT 'Digest of the extension package content.',
    manifest_json LONGTEXT NOT NULL COMMENT 'Validated extension package manifest.',
    byte_length BIGINT UNSIGNED NOT NULL COMMENT 'Total published package size in bytes.',
    state VARCHAR(16) NOT NULL COMMENT 'Package publication state: PREPARING or PUBLISHED.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_extension_package_business_key UNIQUE (package_key),
    CONSTRAINT uk_ma_extension_package UNIQUE (scope_key, extension_id, package_revision),
    CONSTRAINT ck_ma_extension_package_revision CHECK (package_revision > 0),
    CONSTRAINT ck_ma_extension_package_bytes CHECK (byte_length >= 0 AND byte_length <= 104857600),
    CONSTRAINT ck_ma_extension_package_state CHECK (CASE state WHEN 'PREPARING' THEN 9 WHEN 'PUBLISHED' THEN 9 ELSE -1 END = CHAR_LENGTH(state)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_extension_package_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Versioned Workspace extension package manifests and publication state.';

CREATE TABLE ma_extension_settings (
    settings_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the scoped extension settings revision.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Workspace identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    extension_id VARBINARY(128) NOT NULL COMMENT 'Workspace extension identity.',
    settings_revision BIGINT UNSIGNED NOT NULL COMMENT 'Immutable extension settings revision.',
    encryption_key_id VARBINARY(128) NOT NULL COMMENT 'Identifier of the key used to encrypt stored content.',
    encrypted_values LONGTEXT NOT NULL COMMENT 'Encrypted serialized extension setting values.',
    configured_keys_json LONGTEXT NOT NULL COMMENT 'Configured setting names, without their secret values.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_extension_settings_business_key UNIQUE (settings_key),
    CONSTRAINT uk_ma_extension_settings UNIQUE (scope_key, extension_id, settings_revision),
    CONSTRAINT ck_ma_extension_settings_revision CHECK (settings_revision > 0),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_extension_settings_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Immutable Workspace extension settings revisions with encrypted values.';

CREATE TABLE ma_extension_operation (
    operation_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the durable operation.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and Workspace identity.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    actor_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the actor owning the extension operation.',
    operation_id VARCHAR(128) NOT NULL COMMENT 'Stable operation identity.',
    extension_id VARBINARY(128) NOT NULL COMMENT 'Workspace extension identity.',
    operation_kind VARCHAR(16) NOT NULL COMMENT 'Extension mutation type: publish or settings.',
    revision BIGINT UNSIGNED NOT NULL COMMENT 'Package or settings revision assigned to this operation.',
    package_digest CHAR(64) COMMENT 'Digest of the extension package content.',
    request_digest CHAR(64) NOT NULL COMMENT 'Request digest used to reject conflicting retries.',
    state VARCHAR(16) NOT NULL COMMENT 'Operation settlement state: pending or settled.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_extension_operation_business_key UNIQUE (operation_key),
    CONSTRAINT ck_ma_extension_operation_revision CHECK (revision > 0),
    CONSTRAINT ck_ma_extension_operation_kind CHECK (CASE operation_kind WHEN 'publish' THEN 7 WHEN 'settings' THEN 8 ELSE -1 END = CHAR_LENGTH(operation_kind)),
    CONSTRAINT ck_ma_extension_operation_state CHECK (CASE state WHEN 'pending' THEN 7 WHEN 'settled' THEN 7 ELSE -1 END = CHAR_LENGTH(state)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_extension_operation_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Idempotent Workspace extension publication and settings mutation receipts.';

CREATE TABLE ma_storage (
    alias_key CHAR(64) NOT NULL COMMENT 'Hashed tenant and logical storage identity.',
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    storage_key CHAR(64) NOT NULL COMMENT 'Storage identity key used for indexed lookup and coordination.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    storage_id VARBINARY(2048) NOT NULL COMMENT 'Logical storage identity.',
    physical_key CHAR(64) COMMENT 'Canonical physical storage identity shared by logical aliases.',
    registration_state VARCHAR(16) NOT NULL DEFAULT 'FENCE_ONLY' COMMENT 'Registration state: FENCE_ONLY, REGISTERED, RETIRING, or RETIRED.',
    storage_kind VARCHAR(16) NOT NULL DEFAULT 'UNREGISTERED' COMMENT 'Storage backend or registration kind.',
    registration_revision BIGINT UNSIGNED COMMENT 'Revision of the verified physical storage registration.',
    registration_json LONGTEXT COMMENT 'Verified storage registration and backend-specific identity.',
    fence_operation_id VARBINARY(512) COMMENT 'Operation currently fencing new execution on this storage alias.',
    mount_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of the registered mount identity.',
    gmt_create BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_storage_business_key UNIQUE (alias_key),
    CONSTRAINT uk_ma_storage_alias UNIQUE (tenant_key, storage_key),
    CONSTRAINT ck_ma_storage_registration CHECK ((CASE registration_state WHEN 'FENCE_ONLY' THEN 10 WHEN 'REGISTERED' THEN 10 WHEN 'RETIRING' THEN 8 WHEN 'RETIRED' THEN 7 ELSE -1 END = CHAR_LENGTH(registration_state))),
    CONSTRAINT ck_ma_storage_registered CHECK (registration_state = 'FENCE_ONLY' OR (physical_key IS NOT NULL AND registration_revision IS NOT NULL AND registration_json IS NOT NULL)),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_storage_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Tenant storage aliases, physical registration, and execution admission fences.';

CREATE INDEX idx_ma_storage_physical ON ma_storage (physical_key);

CREATE TABLE ma_runtime_slot (
    request_key CHAR(64) NOT NULL COMMENT 'Hashed Runtime request identity selecting a stable slot.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    workspace_generation VARBINARY(2048) NOT NULL COMMENT 'Workspace generation captured for this binding.',
    canonical_cwd VARCHAR(512) NOT NULL COMMENT 'Canonical working directory for the Runtime request.',
    capability_digest VARBINARY(2048) NOT NULL COMMENT 'Digest identifying the requested Runtime capabilities.',
    isolation_class VARCHAR(32) NOT NULL COMMENT 'Runtime isolation policy.',
    isolation_key VARBINARY(2048) COMMENT 'Identity of the scope isolated by the Runtime binding.',
    provisioner_kind VARCHAR(512) NOT NULL COMMENT 'Runtime provisioner implementation kind.',
    storage_id VARBINARY(1024) COMMENT 'Logical storage identity.',
    last_generation BIGINT UNSIGNED NOT NULL COMMENT 'Last allocated Runtime generation, retained after binding collection.',
    active_binding_id VARBINARY(2048) COMMENT 'Current binding identity, if the slot has an active binding.',
    CONSTRAINT uk_ma_runtime_slot_business_key UNIQUE (request_key),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_runtime_slot_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Stable Runtime request slots retaining generation counters across binding collection.';

CREATE TABLE ma_runtime_binding (
    binding_id VARBINARY(2048) NOT NULL COMMENT 'Runtime binding identity.',
    request_key CHAR(64) NOT NULL COMMENT 'Hashed Runtime request identity selecting a stable slot.',
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed scope identity used to partition records.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    workspace_generation VARBINARY(2048) NOT NULL COMMENT 'Workspace generation captured for this binding.',
    canonical_cwd VARCHAR(512) NOT NULL COMMENT 'Canonical working directory for the Runtime request.',
    capability_digest VARBINARY(2048) NOT NULL COMMENT 'Digest identifying the requested Runtime capabilities.',
    isolation_class VARCHAR(32) NOT NULL COMMENT 'Runtime isolation policy.',
    isolation_key VARBINARY(2048) COMMENT 'Identity of the scope isolated by the Runtime binding.',
    provisioner_kind VARCHAR(512) NOT NULL COMMENT 'Runtime provisioner implementation kind.',
    storage_id VARBINARY(1024) COMMENT 'Logical storage identity.',
    storage_alias_key CHAR(64) COMMENT 'Hashed tenant and storage alias used for admission and recovery checks.',
    runtime_generation BIGINT UNSIGNED NOT NULL COMMENT 'Generation of the referenced Runtime binding.',
    binding_state VARCHAR(32) NOT NULL COMMENT 'Provisioning, readiness, drain, or terminal state of this Runtime generation.',
    provision_request_id VARBINARY(2048) COMMENT 'Stable provisioner request identity retained across retries.',
    provision_seed_ciphertext LONGTEXT COMMENT 'Encrypted provisioning seed retained for idempotent provisioning.',
    is_provision_seeded TINYINT UNSIGNED GENERATED ALWAYS AS (provision_seed_ciphertext IS NOT NULL)
        COMMENT 'Generated flag indicating durable provisioning seed evidence.',
    credential_key_id VARBINARY(2048) COMMENT 'Encryption key identifier for the provisioning seed.',
    resource_handle_version INT UNSIGNED COMMENT 'Version of the provisioner resource-handle format.',
    resource_handle_json LONGTEXT COMMENT 'Durable provisioner resource handle for lookup, stop, and recovery.',
    loss_evidence_json LONGTEXT COMMENT 'Evidence that the original Runtime was lost.',
    stop_evidence_json LONGTEXT COMMENT 'Evidence that the original Runtime was stopped.',
    runtime_instance_id VARBINARY(2048) COMMENT 'Identity of the provisioned Runtime instance.',
    runtime_endpoint VARCHAR(2048) COMMENT 'Endpoint used to contact the Runtime.',
    runtime_lease_id VARBINARY(2048) COMMENT 'Lease identity issued by the Runtime provisioner.',
    runtime_epoch BIGINT UNSIGNED COMMENT 'Runtime incarnation epoch returned by the provisioner.',
    runtime_credential_ciphertext LONGTEXT COMMENT 'Encrypted credential used to contact the Runtime.',
    runtime_credential_key_id VARBINARY(2048) COMMENT 'Encryption key identifier for the Runtime credential.',
    attestation_generation BIGINT UNSIGNED NOT NULL COMMENT 'Generation of Runtime identity or health attestation.',
    is_drain_requested TINYINT UNSIGNED NOT NULL COMMENT 'Whether new work must stop while the Runtime is drained.',
    operation_owner VARBINARY(2048) COMMENT 'Worker holding the Runtime lifecycle operation claim.',
    operation_lease_until BIGINT UNSIGNED COMMENT 'Runtime lifecycle claim expiry in Unix epoch milliseconds.',
    operation_generation BIGINT UNSIGNED NOT NULL COMMENT 'Monotonic Runtime lifecycle claim generation.',
    record_version BIGINT UNSIGNED NOT NULL COMMENT 'Optimistic concurrency version of the Runtime record.',
    last_health_at BIGINT UNSIGNED COMMENT 'Last Runtime health observation in Unix epoch milliseconds.',
    last_reconciled_at BIGINT UNSIGNED COMMENT 'Last Runtime reconciliation time in Unix epoch milliseconds.',
    last_active_at BIGINT UNSIGNED NOT NULL COMMENT 'Most recent activity time in Unix epoch milliseconds.',
    CONSTRAINT uk_runtime_binding_generation
        UNIQUE (request_key, runtime_generation),
    INDEX idx_runtime_binding_scope
        (scope_key, isolation_key, binding_state),
    INDEX qwen_runtime_harness_bindings_idx (isolation_key, isolation_class),
    INDEX qwen_runtime_storage_bindings_idx (storage_id, binding_id),
    drain_receipt_json LONGTEXT COMMENT 'Durable receipt of the Runtime drain operation.',
    first_activation_journal_revision BIGINT UNSIGNED COMMENT 'Journal revision of the first activation associated with this binding.',
    CONSTRAINT uk_ma_runtime_binding_business_key UNIQUE (binding_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_runtime_binding_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_runtime_binding_boolean_values CHECK ((is_provision_seeded >= 0 AND is_provision_seeded <= 1) AND (is_drain_requested >= 0 AND is_drain_requested <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='One Runtime generation, its provisioned identity, credentials, and lifecycle evidence.';

CREATE INDEX idx_ma_runtime_storage_alias_state ON ma_runtime_binding (storage_alias_key, binding_state, is_provision_seeded, binding_id);

CREATE TABLE ma_runtime_session (
    scope_key CHAR(64) NOT NULL COMMENT 'Hashed scope identity used to partition records.',
    runtime_session_id VARBINARY(2048) NOT NULL COMMENT 'Runtime execution Session identity.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    workspace_generation VARBINARY(2048) NOT NULL COMMENT 'Workspace generation captured for this binding.',
    canonical_cwd VARCHAR(512) NOT NULL COMMENT 'Canonical working directory for the Runtime request.',
    capability_digest VARBINARY(2048) NOT NULL COMMENT 'Digest identifying the requested Runtime capabilities.',
    isolation_class VARCHAR(32) NOT NULL COMMENT 'Runtime isolation policy.',
    harness_session_id VARBINARY(2048) NOT NULL COMMENT 'Originating Harness Session identity.',
    turn_kind VARCHAR(32) NOT NULL COMMENT 'Execution turn kind used for Runtime Session admission.',
    binding_id VARBINARY(2048) NOT NULL COMMENT 'Runtime binding identity.',
    runtime_generation BIGINT UNSIGNED NOT NULL COMMENT 'Generation of the referenced Runtime binding.',
    session_state VARCHAR(32) NOT NULL COMMENT 'Runtime Session lifecycle state.',
    record_version BIGINT UNSIGNED NOT NULL COMMENT 'Optimistic concurrency version of the Runtime record.',
    last_active_at BIGINT UNSIGNED NOT NULL COMMENT 'Most recent activity time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_runtime_session_business_key UNIQUE (scope_key, runtime_session_id),
    INDEX idx_runtime_session_binding
        (binding_id, runtime_generation, session_state),
    INDEX idx_runtime_session_id (runtime_session_id),
    execution_storage_key CHAR(64) COMMENT 'Physical storage coordination key for active execution membership.',
    is_execution_exclusive TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Whether this execution membership requires exclusive storage access.',
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_runtime_session_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_runtime_session_boolean_values CHECK ((is_execution_exclusive >= 0 AND is_execution_exclusive <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Runtime execution Sessions attached to a binding and originating Harness Session.';

CREATE TABLE ma_tool_execution (
    execution_call_id_hash CHAR(64) NOT NULL COMMENT 'Hash of the stable execution-call identity.',
    execution_call_id VARBINARY(2048) NOT NULL COMMENT 'Original stable identity of the tool execution.',
    idempotency_key_hash CHAR(64) NOT NULL COMMENT 'Hash enforcing tool execution idempotency.',
    idempotency_key VARBINARY(2048) NOT NULL COMMENT 'Original key identifying retries of the same request.',
    binding_id VARBINARY(2048) NOT NULL COMMENT 'Runtime binding identity.',
    runtime_generation BIGINT UNSIGNED NOT NULL COMMENT 'Generation of the referenced Runtime binding.',
    harness_session_id VARBINARY(2048) NOT NULL COMMENT 'Originating Harness Session identity.',
    runtime_session_id VARBINARY(2048) NOT NULL COMMENT 'Runtime execution Session identity.',
    runtime_session_key CHAR(64) NOT NULL COMMENT 'Hashed scoped Runtime Session identity.',
    turn_id VARBINARY(2048) NOT NULL COMMENT 'Turn identity within the Session.',
    tool_call_id VARBINARY(2048) NOT NULL COMMENT 'Tool-call identity within the originating Turn.',
    request_digest VARCHAR(512) NOT NULL COMMENT 'Request digest used to reject conflicting retries.',
    reference_json LONGTEXT NOT NULL COMMENT 'Serialized execution reference pinned at admission.',
    execution_state VARCHAR(32) NOT NULL COMMENT 'Execution lifecycle state used for dispatch and recovery.',
    execution_status VARCHAR(32) COMMENT 'Terminal or reported tool result status.',
    result_json LONGTEXT COMMENT 'Serialized durable result returned on completion or replay.',
    last_sequence BIGINT UNSIGNED NOT NULL COMMENT 'Latest observed tool execution event sequence.',
    is_cancel_requested TINYINT UNSIGNED NOT NULL COMMENT 'Whether cancellation has been requested.',
    dispatch_owner VARBINARY(2048) COMMENT 'Worker currently claiming dispatch responsibility.',
    dispatch_lease_until BIGINT UNSIGNED COMMENT 'Dispatch claim expiry in Unix epoch milliseconds.',
    dispatch_generation BIGINT UNSIGNED NOT NULL COMMENT 'Monotonic dispatch claim generation fencing stale workers.',
    record_version BIGINT UNSIGNED NOT NULL COMMENT 'Optimistic concurrency version of the Runtime record.',
    settled_at BIGINT UNSIGNED COMMENT 'Settlement time in Unix epoch milliseconds.',
    abandoned_at BIGINT UNSIGNED COMMENT 'Abandonment time in Unix epoch milliseconds.',
    loss_evidence_id VARBINARY(2048) COMMENT 'Identity of the evidence used to classify the execution as lost.',
    authorized_dispatch_generation BIGINT UNSIGNED COMMENT 'Dispatch generation authorized to perform the native operation.',
    authorized_binding_version BIGINT UNSIGNED COMMENT 'Runtime binding version checked when native dispatch was authorized.',
    CONSTRAINT uk_tool_execution_idempotency
        UNIQUE (idempotency_key_hash),
    INDEX idx_tool_execution_session
        (runtime_session_key, execution_state),
    INDEX idx_tool_execution_binding
        (binding_id, runtime_generation, execution_state),
    INDEX idx_tool_execution_harness
        (harness_session_id, execution_call_id_hash),
    native_authorization_json LONGTEXT COMMENT 'Durable authorization evidence for a native tool operation.',
    CONSTRAINT uk_ma_tool_execution_business_key UNIQUE (execution_call_id_hash),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_tool_execution_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_tool_execution_boolean_values CHECK ((is_cancel_requested >= 0 AND is_cancel_requested <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Idempotent tool executions, dispatch fencing, cancellation, and terminal results.';

CREATE TABLE ma_storage_owner (
    storage_key CHAR(64) NOT NULL COMMENT 'Canonical storage coordination key for ownership and execution membership.',
    holder_key CHAR(64) COMMENT 'Identity of the exclusive storage holder, when present.',
    binding_id VARBINARY(2048) COMMENT 'Runtime binding identity.',
    runtime_generation BIGINT UNSIGNED COMMENT 'Generation of the referenced Runtime binding.',
    runtime_session_id VARBINARY(2048) COMMENT 'Runtime execution Session identity.',
    tenant_id VARBINARY(1024) COMMENT 'Tenant identity used for isolation.',
    storage_id VARBINARY(1024) COMMENT 'Logical storage identity.',
    mount_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Revision of the registered mount identity.',
    mount_state VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED' COMMENT 'Verification or maintenance state of the registered mount.',
    mount_operation_id CHAR(36) COMMENT 'Current mount registration or maintenance operation identity.',
    mount_completed_operation_id CHAR(36) COMMENT 'Last completed mount operation identity used for replay.',
    mount_root VARCHAR(2048) COMMENT 'Canonical root path of the registered mount.',
    mount_host_id VARCHAR(256) COMMENT 'Host identity associated with the registered mount.',
    mount_device VARCHAR(32) COMMENT 'Native filesystem device identity.',
    mount_inode VARCHAR(32) COMMENT 'Native filesystem inode identity of the registered root.',
    mount_birth_time VARCHAR(64) COMMENT 'Canonical native creation timestamp of the registered root.',
    mount_registration_id CHAR(36) COMMENT 'Stable native mount registration identity.',
    storage_kind VARCHAR(16) NOT NULL DEFAULT 'LOCAL' COMMENT 'Storage backend or registration kind.',
    csi_phase VARCHAR(16) NOT NULL DEFAULT 'RELEASED' COMMENT 'CSI reservation or ownership phase.',
    csi_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic CSI reservation revision.',
    csi_reservation_id CHAR(36) COMMENT 'Current CSI reservation identity.',
    csi_registration_key CHAR(64) COMMENT 'Storage registration key pinned by the CSI reservation.',
    csi_registration_revision BIGINT UNSIGNED COMMENT 'Storage registration revision pinned by the CSI reservation.',
    csi_provision_request_id VARBINARY(2048) COMMENT 'Provisioner request identity bound to the CSI reservation.',
    maintenance_id CHAR(32) COMMENT 'Identity of the maintenance operation fencing storage.',
    maintenance_generation BIGINT UNSIGNED COMMENT 'Maintenance generation fencing stale maintenance owners.',
    INDEX idx_execution_lease_maintenance (maintenance_id),
    physical_key CHAR(64) COMMENT 'Canonical physical storage identity shared by logical aliases.',
    CONSTRAINT uk_ma_storage_owner_physical UNIQUE (physical_key),
    CONSTRAINT uk_ma_storage_owner_business_key UNIQUE (storage_key),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_storage_owner_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Physical storage ownership, mount identity, CSI reservations, and maintenance fences.';

CREATE INDEX idx_ma_storage_owner_binding ON ma_storage_owner (binding_id, runtime_generation, storage_key);

CREATE TABLE ma_tenant_guard (
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    tenant_id VARBINARY(2048) NOT NULL COMMENT 'Tenant identity used for isolation.',
    guard_domain VARCHAR(32) NOT NULL COMMENT 'Lock domain: runtime_placement or output_publication.',
    CONSTRAINT pk_ma_tenant_guard PRIMARY KEY (tenant_key, guard_domain),
    CONSTRAINT ck_ma_guard_domain CHECK ((CASE guard_domain WHEN 'runtime_placement' THEN 17 WHEN 'output_publication' THEN 18 ELSE -1 END = CHAR_LENGTH(guard_domain))),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT uk_ma_tenant_guard_id UNIQUE (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Tenant-scoped lock rows coordinating Runtime placement and output publication.';

CREATE TABLE ma_read_lease (
    lease_id VARBINARY(144) NOT NULL COMMENT 'Unique identity of the resource reader lease.',
    tenant_key CHAR(64) NOT NULL COMMENT 'Hashed tenant identity used for indexed lookup.',
    session_key CHAR(64) NOT NULL COMMENT 'Hashed Session identity used for indexed lookup.',
    retirement_generation BIGINT UNSIGNED NOT NULL COMMENT 'Session retirement generation captured when the lease was acquired.',
    expires_at BIGINT UNSIGNED NOT NULL COMMENT 'Expiry time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_read_lease_business_key UNIQUE (lease_id),
    CONSTRAINT ck_ma_read_generation CHECK (retirement_generation >= 0),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_read_lease_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Resource read leases tied to a Session retirement generation.';

CREATE INDEX idx_ma_read_session ON ma_read_lease (tenant_key, session_key, expires_at);

CREATE TABLE ma_channel_instance (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    channel_id VARBINARY(512) NOT NULL COMMENT 'External channel instance identity within the tenant.',
    platform VARCHAR(64) NOT NULL COMMENT 'External messaging platform identifier.',
    account_id VARBINARY(2048) NOT NULL COMMENT 'External platform account identity.',
    account_generation BIGINT UNSIGNED NOT NULL COMMENT 'Channel account generation fencing earlier account bindings.',
    state VARCHAR(16) NOT NULL COMMENT 'Channel instance lifecycle state.',
    actor_id VARBINARY(2048) NOT NULL COMMENT 'Actor identity under which the channel operates.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    cwd_relative VARCHAR(1024) NOT NULL COMMENT 'Working directory relative to the Workspace root.',
    policy_json LONGTEXT NOT NULL COMMENT 'Serialized channel routing and execution policy.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_channel_instance_business_key UNIQUE (tenant_id, channel_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_channel_instance_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='External channel accounts, Workspace context, and routing policy.';

CREATE TABLE ma_channel_binding (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    channel_id VARBINARY(512) NOT NULL COMMENT 'External channel instance identity within the tenant.',
    route_id VARBINARY(512) NOT NULL COMMENT 'Stable identity of the external conversation route.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    scope_kind VARCHAR(16) NOT NULL COMMENT 'Routing scope selecting sender, chat, or thread identity.',
    sender_id VARBINARY(2048) COMMENT 'External sender identity when routing by sender.',
    chat_id VARBINARY(2048) COMMENT 'External chat or conversation identity.',
    thread_id VARBINARY(2048) COMMENT 'External thread identity when routing by thread.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_channel_binding_business_key UNIQUE (tenant_id, channel_id, route_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_channel_binding_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Stable external conversation routes bound to Managed Sessions.';

CREATE INDEX idx_ma_channel_created ON ma_channel_instance (tenant_id, gmt_create, channel_id);

CREATE INDEX idx_ma_channel_binding_session ON ma_channel_binding (tenant_id, session_id);

CREATE TABLE ma_delivery (
    delivery_key CHAR(64) NOT NULL COMMENT 'Hashed identity of the scoped delivery.',
    delivery_kind VARCHAR(32) NOT NULL COMMENT 'Delivery type: CHANNEL, SESSION_MESSAGE, or CHILD_RESULT.',
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    channel_id VARBINARY(512) COMMENT 'External channel instance identity within the tenant.',
    delivery_id VARBINARY(2048) NOT NULL COMMENT 'Stable delivery identity retained across retries.',
    source_session_id VARBINARY(512) COMMENT 'Session that produced the message or result.',
    target_session_id VARBINARY(512) COMMENT 'Session receiving a relayed message or child result.',
    source_scope_key CHAR(64) NOT NULL COMMENT 'Hashed source scope used for delivery lookup and uniqueness.',
    source_record_key CHAR(64) COMMENT 'Source domain record associated with the delivery.',
    source_revision BIGINT UNSIGNED COMMENT 'Source record revision captured by the delivery.',
    segment_id VARBINARY(512) COMMENT 'Identity of an external channel message segment.',
    segment_ordinal BIGINT UNSIGNED COMMENT 'Ordering position of a segment within the delivery.',
    creation_key VARBINARY(2048) COMMENT 'Original child-Session creation identity for child-result recovery.',
    provider_id VARBINARY(2048) COMMENT 'External provider identity associated with the delivery.',
    provider_receipt_json LONGTEXT COMMENT 'Receipt returned by the external delivery provider.',
    request_digest CHAR(64) COMMENT 'Request digest used to reject conflicting retries.',
    payload_version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Version of the serialized payload format.',
    payload_json LONGTEXT NOT NULL COMMENT 'Serialized work or delivery payload.',
    transport_state VARCHAR(32) NOT NULL COMMENT 'Progress of sending the delivery to its destination.',
    reception_state VARCHAR(32) NOT NULL COMMENT 'Progress of destination acceptance.',
    consumption_state VARCHAR(32) NOT NULL COMMENT 'Progress of consuming the received content.',
    claimed_at BIGINT UNSIGNED COMMENT 'Time the source Session claimed the channel delivery, in Unix epoch milliseconds.',
    reconcile_operation_id VARBINARY(512) COMMENT 'Stable operation identity reserved for uncertain-delivery reconciliation.',
    claim_owner VARBINARY(512) COMMENT 'Worker identity holding the current processing claim.',
    claim_generation BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic claim generation fencing stale workers.',
    claim_until BIGINT UNSIGNED COMMENT 'Processing claim expiry in Unix epoch milliseconds.',
    attempt_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of processing attempts.',
    available_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Earliest processing time in Unix epoch milliseconds.',
    last_error VARCHAR(2048) COMMENT 'Most recent diagnostic failure message.',
    failure_code VARCHAR(128) COMMENT 'Machine-readable failure code.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_delivery_business_key UNIQUE (delivery_key),
    CONSTRAINT uk_ma_delivery_identity UNIQUE (delivery_kind, source_scope_key, delivery_id),
    CONSTRAINT ck_ma_delivery_kind CHECK ((CASE delivery_kind WHEN 'CHANNEL' THEN 7 WHEN 'SESSION_MESSAGE' THEN 15 WHEN 'CHILD_RESULT' THEN 12 ELSE -1 END = CHAR_LENGTH(delivery_kind))),
    CONSTRAINT ck_ma_delivery_source CHECK (delivery_kind = 'CHANNEL' OR source_session_id IS NOT NULL),
    CONSTRAINT ck_ma_delivery_claim_source CHECK (claimed_at IS NULL OR source_session_id IS NOT NULL),
    CONSTRAINT ck_ma_delivery_generation CHECK (claim_generation >= 0 AND attempt_count >= 0),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_delivery_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Reliable channel, Session-message, and child-result delivery with separate progress states.';

CREATE INDEX idx_ma_delivery_poll ON ma_delivery (delivery_kind, transport_state, available_at);

CREATE INDEX idx_ma_delivery_claim ON ma_delivery (delivery_kind, claim_until);

CREATE INDEX idx_ma_delivery_channel ON ma_delivery (tenant_id, channel_id, claimed_at);

CREATE INDEX idx_ma_delivery_session ON ma_delivery (source_scope_key, delivery_kind, consumption_state);

CREATE TABLE ma_schedule (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    schedule_id VARBINARY(512) NOT NULL COMMENT 'Automation schedule identity within the tenant.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Managed Session identity.',
    workspace_id VARBINARY(2048) NOT NULL COMMENT 'Workspace identity within the tenant.',
    actor_id VARBINARY(2048) NOT NULL COMMENT 'Actor identity associated with this record.',
    record_revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision of the private schedule domain record.',
    definition_revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision of the associated immutable definition.',
    definition_digest CHAR(64) NOT NULL COMMENT 'Digest of the immutable schedule definition.',
    goal VARCHAR(4096) NOT NULL COMMENT 'Goal or prompt submitted when the schedule triggers.',
    cron VARCHAR(4096) NOT NULL COMMENT 'Cron expression defining scheduled trigger times.',
    timezone VARCHAR(256) NOT NULL COMMENT 'Timezone used to interpret the cron expression.',
    session_mode VARCHAR(16) NOT NULL COMMENT 'Policy for reusing or creating a Session for a scheduled run.',
    overlap VARCHAR(16) NOT NULL COMMENT 'Policy for a trigger that overlaps an earlier run.',
    catch_up VARCHAR(16) NOT NULL COMMENT 'Policy for handling missed scheduled trigger slots.',
    catch_up_limit BIGINT UNSIGNED NULL COMMENT 'Maximum missed slots admitted by the catch-up policy.',
    is_enabled TINYINT UNSIGNED NOT NULL COMMENT 'Whether the authoritative schedule definition is enabled.',
    state VARCHAR(16) NOT NULL COMMENT 'Operational scheduling state.',
    blocked_reason VARCHAR(1024) NULL COMMENT 'Reason the schedule cannot currently trigger work.',
    armed_at BIGINT UNSIGNED NOT NULL COMMENT 'Time scheduling was armed, in Unix epoch milliseconds.',
    watermark_slot BIGINT UNSIGNED NULL COMMENT 'Latest processed scheduled slot in Unix epoch milliseconds.',
    lease_owner VARBINARY(512) NULL COMMENT 'Scheduler worker holding the scan lease.',
    lease_until BIGINT UNSIGNED NULL COMMENT 'Scheduler scan lease expiry in Unix epoch milliseconds.',
    fence BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Monotonic scheduler generation fencing stale scan owners.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    gate VARCHAR(2048) NULL COMMENT 'Optional gate command evaluated before delivering scheduled input.',
    gate_last_outcome VARCHAR(16) NULL COMMENT 'Most recently recorded gate outcome.',
    gate_last_at BIGINT UNSIGNED NULL COMMENT 'Last gate evaluation time in Unix epoch milliseconds.',
    gate_quiet_since_delivery INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Quiet gate outcomes since the last delivered occurrence.',
    gate_failures INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Consecutive failed, blocked, or unknown gate outcomes.',
    gate_last_error VARCHAR(1024) NULL COMMENT 'Most recent gate failure detail.',
    CONSTRAINT uk_ma_schedule_business_key UNIQUE (tenant_id, schedule_id),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_schedule_id PRIMARY KEY (id),
    CONSTRAINT ck_ma_schedule_boolean_values CHECK ((is_enabled >= 0 AND is_enabled <= 1))
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Automation schedule projections, scan leases, trigger watermarks, and gate outcomes.';

CREATE TABLE ma_schedule_occurrence (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    schedule_id VARBINARY(512) NOT NULL COMMENT 'Automation schedule identity within the tenant.',
    occurrence_key VARBINARY(640) NOT NULL COMMENT 'Stable identity of a scheduled or manual trigger occurrence.',
    run_id VARBINARY(512) NOT NULL COMMENT 'Automation run identity assigned to the occurrence.',
    session_id VARBINARY(2048) NOT NULL COMMENT 'Session associated with this trigger occurrence.',
    slot BIGINT UNSIGNED NULL COMMENT 'Scheduled trigger time in Unix epoch milliseconds, when applicable.',
    trigger_kind VARCHAR(16) NOT NULL COMMENT 'Source of the trigger, such as scheduled or manual.',
    outcome VARCHAR(16) NOT NULL COMMENT 'Recorded trigger outcome, including admitted, skipped, missed, or unknown results.',
    reason VARCHAR(64) NULL COMMENT 'Machine-readable reason for the recorded outcome.',
    definition_revision BIGINT UNSIGNED NOT NULL COMMENT 'Revision of the associated immutable definition.',
    fence BIGINT UNSIGNED NOT NULL COMMENT 'Scheduler generation under which the occurrence was admitted.',
    attempts INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Number of delivery or reconciliation attempts for this occurrence.',
    next_retry_at BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Earliest retry time in Unix epoch milliseconds.',
    last_error VARCHAR(1024) NULL COMMENT 'Most recent diagnostic failure message.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_schedule_occurrence_business_key UNIQUE (tenant_id, schedule_id, occurrence_key),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_schedule_occurrence_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Durable scheduled or manual trigger outcomes and retry progress.';

CREATE INDEX idx_ma_schedule_scan ON ma_schedule (state, is_enabled, lease_until);

CREATE INDEX idx_ma_schedule_list ON ma_schedule (tenant_id, gmt_create, schedule_id);

CREATE INDEX idx_ma_schedule_session ON ma_schedule (tenant_id, session_id);

CREATE INDEX idx_ma_occurrence_list ON ma_schedule_occurrence (tenant_id, schedule_id, gmt_create, occurrence_key);

CREATE INDEX idx_ma_occurrence_outcome ON ma_schedule_occurrence (tenant_id, schedule_id, outcome);

CREATE INDEX idx_ma_work_page ON ma_operation_work (operation_key, work_kind, target_key);

CREATE INDEX idx_ma_work_session_page ON ma_operation_work (operation_key, work_kind, session_id);

CREATE INDEX idx_ma_work_pending ON ma_operation_work (operation_key, work_kind, session_id, state, target_key);

CREATE INDEX idx_ma_operation_target_raw ON ma_operation (operation_kind, target_id, target_revision, state);

CREATE INDEX idx_ma_operation_raw_id ON ma_operation (operation_kind, operation_id);

CREATE INDEX idx_ma_channel_delivery_page ON ma_delivery (delivery_kind, source_scope_key, gmt_create, delivery_id);

CREATE INDEX idx_ma_channel_delivery_expiry ON ma_delivery (delivery_kind, transport_state, claimed_at, delivery_id);

CREATE INDEX idx_ma_receipt_ingress_lookup ON ma_request_receipt (namespace, tenant_key, idempotency_digest);

CREATE INDEX idx_ma_receipt_ingress_page ON ma_request_receipt (namespace, tenant_key, channel_id, gmt_create, idempotency_key);

CREATE INDEX idx_ma_operation_state_due ON ma_operation (operation_kind, state, available_at, operation_key);

CREATE INDEX idx_ma_operation_scope_id ON ma_operation (scope_key, operation_kind, operation_id);

CREATE INDEX idx_ma_operation_session_state ON ma_operation (session_scope_key, operation_kind, state);

CREATE INDEX idx_ma_resource_scope_page ON ma_resource (session_scope_key, resource_key);

CREATE UNIQUE INDEX uk_ma_delivery_reconciliation ON ma_delivery (reconcile_operation_id);

CREATE INDEX idx_ma_operation_gc_due ON ma_operation (operation_kind, available_at, operation_key);

CREATE INDEX idx_ma_operation_result_due ON ma_operation (operation_kind, state, available_at, operation_id);

CREATE INDEX idx_ma_operation_result_lease ON ma_operation (operation_kind, state, claim_until, operation_id);

CREATE INDEX idx_ma_hook_definition ON ma_session_record (session_scope_key, hook_definition_hash, record_kind);

-- Runtime history cleanup uses these predicates without scanning active families.
CREATE INDEX idx_ma_runtime_retention ON ma_runtime_binding (binding_state, last_active_at, binding_id);

CREATE INDEX idx_ma_runtime_tenant_state ON ma_runtime_binding (tenant_id, binding_state);

CREATE INDEX idx_ma_capture_execution ON ma_output_capture (execution_key);

CREATE INDEX idx_ma_work_execution ON ma_operation_work (work_kind, target_key, operation_key);

CREATE INDEX idx_ma_session_csi_guard ON ma_session (tenant_id, session_id, is_csi_guard);
-- Session lists page on the immutable gmt_create keyset: gmt_modified moves on every event append.
CREATE INDEX idx_ma_session_list ON ma_session (tenant_id, gmt_create, session_id);
CREATE INDEX idx_ma_storage_owner_host ON ma_storage_owner (mount_host_id /*!50000 (64) */, storage_kind);
-- Session close releases one Harness Session's Runtime Sessions across shared bindings.
CREATE INDEX idx_ma_runtime_session_harness ON ma_runtime_session (harness_session_id);
CREATE INDEX idx_ma_head_wake ON ma_session_head (is_wake_scan_pending, wake_retry_at, tenant_key, harness_key);
CREATE INDEX idx_ma_ref_binding ON ma_resource_ref (owner_kind, runtime_binding_key, owner_revision);
CREATE INDEX idx_ma_head_session ON ma_session_head (tenant_key, session_id, head_kind);
CREATE INDEX idx_ma_runtime_execution_storage ON ma_runtime_session (execution_storage_key);

CREATE TABLE ma_session_worktree (
    tenant_id VARBINARY(512) NOT NULL COMMENT 'Tenant identity used for isolation.',
    session_id VARBINARY(512) NOT NULL COMMENT 'Managed Session identity.',
    workspace_id VARBINARY(512) NOT NULL COMMENT 'Workspace identity within the tenant.',
    storage_id VARBINARY(512) NOT NULL COMMENT 'Logical storage identity.',
    physical_key CHAR(64) NOT NULL COMMENT 'Canonical physical storage identity shared by logical aliases.',
    worktree_id CHAR(32) NOT NULL COMMENT 'Stable identity of the Session-owned Git worktree.',
    owner_actor_key VARBINARY(2048) NOT NULL COMMENT 'Encoded actor identity owning the Session worktree.',
    state VARCHAR(16) NOT NULL COMMENT 'Worktree lifecycle state: PREPARING, READY, FAILED, BLOCKED, REMOVING, or REMOVED.',
    revision BIGINT UNSIGNED NOT NULL COMMENT 'Monotonic worktree state revision.',
    plan_json LONGTEXT NOT NULL COMMENT 'Frozen worktree creation or removal plan.',
    identity_json LONGTEXT COMMENT 'Verified Git worktree and filesystem identity.',
    operation_id VARBINARY(512) NOT NULL COMMENT 'Stable operation identity.',
    failure_code VARCHAR(128) COMMENT 'Machine-readable failure code.',
    gmt_create BIGINT UNSIGNED NOT NULL COMMENT 'Record creation time in Unix epoch milliseconds.',
    gmt_modified BIGINT UNSIGNED NOT NULL COMMENT 'Last record update time in Unix epoch milliseconds.',
    CONSTRAINT uk_ma_session_worktree_business_key UNIQUE (tenant_id, session_id),
    CONSTRAINT uk_ma_session_worktree UNIQUE (tenant_id, worktree_id),
    CONSTRAINT ck_ma_session_worktree_state CHECK ((CASE state WHEN 'PREPARING' THEN 9 WHEN 'READY' THEN 5 WHEN 'FAILED' THEN 6 WHEN 'BLOCKED' THEN 7 WHEN 'REMOVING' THEN 8 WHEN 'REMOVED' THEN 7 ELSE -1 END = CHAR_LENGTH(state))),
    CONSTRAINT ck_ma_session_worktree_revision CHECK (revision > 0),
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Database-generated identity of this row.',
    CONSTRAINT pk_ma_session_worktree_id PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin COMMENT='Session-owned Git worktree preparation, identity, removal, and recovery state.';

CREATE INDEX idx_ma_session_worktree_workspace ON ma_session_worktree (tenant_id, workspace_id, gmt_create);
CREATE INDEX idx_ma_session_worktree_storage ON ma_session_worktree (physical_key, state);

CREATE INDEX idx_ma_message_body_resource_key ON ma_message (body_resource_key);

CREATE INDEX idx_ma_output_capture_manifest_resource_key ON ma_output_capture (manifest_resource_key);

CREATE INDEX idx_ma_output_capture_seal_manifest_resource_key ON ma_output_capture (seal_manifest_resource_key);

CREATE INDEX idx_ma_event_stream_artifact_refs_resource_key ON ma_event_stream (artifact_refs_resource_key);

CREATE INDEX idx_ma_extension_package_workspace ON ma_extension_package (tenant_id, workspace_id);

CREATE INDEX idx_ma_extension_settings_workspace ON ma_extension_settings (tenant_id, workspace_id);

CREATE INDEX idx_ma_extension_operation_workspace ON ma_extension_operation (tenant_id, workspace_id);
