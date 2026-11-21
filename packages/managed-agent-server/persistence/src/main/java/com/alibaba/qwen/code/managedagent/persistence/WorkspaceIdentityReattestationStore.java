package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader;
import com.alibaba.qwen.code.managedagent.contracts.workspace.StorageIdentityReader.Identity;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorktreeFiles;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore.Plan;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Explicit offline establishment of a stable identity for an unchanged legacy root. */
public final class WorkspaceIdentityReattestationStore {
    public static final String TYPE = "same-path-identity-reattest/1";
    private static final String PHASE = "IDENTITY_REATTESTATION";
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.STORAGE_MIGRATION;
    private static final ObjectMapper JSON = new ObjectMapper().enable(DeserializationFeature.USE_LONG_FOR_INTS);
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard guard;
    private final StorageIdentityReader identities;
    private final WorktreeFiles worktrees;

    public WorkspaceIdentityReattestationStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            WorkspaceStorageGuard guard, StorageIdentityReader identities, WorktreeFiles worktrees) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.guard = guard;
        this.identities = identities;
        this.worktrees = worktrees;
    }

    public JsonNode plan(JsonNode input) throws IOException {
        validate(input);
        ObjectNode request = ((ObjectNode) input).deepCopy();
        String physical = text(input, "physicalKey");
        var owners = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, storage_id, mount_root, mount_host_id,"
                + " mount_device, mount_inode, mount_birth_time, mount_registration_id, mount_revision"
                + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                + " AND mount_state = 'READY' AND mount_operation_id IS NULL", physical);
        check(owners.size() == 1, "owner_unavailable");
        JsonNode owner = JSON.valueToTree(owners.getFirst());
        check(owner.path("mount_device").asText().matches("[0-9]{1,20}"), "legacy_owner_required");
        Identity current = identities.read(Path.of(owner.path("mount_root").asText()));
        requireStable(input, owner, current);
        requireOnlyOwner(owner, physical);
        ObjectNode inventory = request.putObject("inventory");
        inventory.set("owner", owner);
        inventory.set("identity", JSON.valueToTree(current));
        inventory.put("newPhysicalKey", LocalStorageOwners.physicalKey(current));
        inventory.set("aliases", aliases(physical));
        check(inventory.path("aliases").size() > 0 && inventory.path("aliases").size() <= 128, "alias_inventory_limit");
        for (JsonNode alias : inventory.path("aliases")) {
            check("LOCAL".equals(alias.path("storage_kind").asText()) && "REGISTERED".equals(alias.path("registration_state").asText())
                    && alias.path("registration_revision").asLong() > 0
                    && alias.path("alias_key").asText().equals(RuntimeAdmissionFences.storageAliasKey(
                            alias.path("tenant_id").asText(), alias.path("storage_id").asText())), "alias_inventory_conflict");
        }
        check(hasAlias(inventory, text(input, "tenantId"), text(input, "storageId")), "alias_inventory_conflict");
        var changes = inventory.putArray("files");
        Path metadata = guard.reattestationMarkerRoot(physical);
        byte[] original = read(metadata.resolve(WorkspaceStorageMarkers.FILE_NAME));
        var marker = JSON.readTree(original);
        check(marker.path("version").asInt() == 2
                && marker.path("tenantId").asText().equals(owner.path("tenant_id").asText())
                && marker.path("storageId").asText().equals(owner.path("storage_id").asText())
                && marker.path("root").asText().equals(current.root())
                && marker.path("hostId").asText().equals(current.hostId())
                && marker.path("device").asText().equals(owner.path("mount_device").asText())
                && marker.path("inode").asText().equals(current.inode())
                && marker.path("birthTime").asText().equals(current.birthTime())
                && marker.path("registrationId").asText().equals(owner.path("mount_registration_id").asText()), "marker_conflict");
        ObjectNode upgraded = ((ObjectNode) marker).deepCopy().put("version", 3).put("device", current.device());
        changes.add(change(metadata.resolve(WorkspaceStorageMarkers.FILE_NAME), original, JSON.writeValueAsBytes(upgraded)));
        inventory.set("worktrees", checkoutRows(physical));
        for (JsonNode checkout : inventory.path("worktrees")) {
            requireCompletedCheckout(checkout);
            Plan plan = JSON.readValue(checkout.path("plan_json").asText(), Plan.class);
            check(plan.tenantId().equals(checkout.path("tenant_id").asText())
                    && plan.storageId().equals(checkout.path("storage_id").asText())
                    && plan.worktreeId().equals(checkout.path("worktree_id").asText())
                    && plan.root().equals(current.root()) && hasAlias(inventory, plan.tenantId(), plan.storageId()), "worktree_scope_conflict");
            String savedIdentity = checkout.path("identity_json").asText();
            String newPlan;
            String newIdentity;
            if (plan.rootIdentity().startsWith("macos-volume/1:")) {
                // Worktrees created between the upgrade and the reboot already carry
                // stable anchors on the legacy owner: verify them against the attested
                // volume and carry their records forward unchanged.
                requireStableAnchors(plan, savedIdentity, current.device());
                worktrees.verify(plan, savedIdentity);
                newPlan = checkout.path("plan_json").asText();
                newIdentity = savedIdentity;
            } else {
                var next = worktrees.reattest(plan, savedIdentity, current.device());
                newPlan = next.get("plan");
                newIdentity = next.get("identity");
            }
            ((ObjectNode) checkout).put("new_plan_json", newPlan).put("new_identity_json", newIdentity);
            Path container = Path.of(plan.root()).resolve(".qwen-managed-worktrees");
            Path planFile = container.resolve(plan.worktreeId() + ".json");
            Path readyFile = container.resolve(plan.worktreeId() + ".ready");
            check(JSON.readTree(read(planFile)).equals(JSON.valueToTree(plan))
                    && JSON.readTree(read(readyFile)).equals(JSON.readTree(savedIdentity)), "marker_conflict");
            changes.add(change(planFile, read(planFile), newPlan.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
            changes.add(change(readyFile, read(readyFile), newIdentity.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        }
        request.put("inventoryDigest", WorkspaceEvidenceResources.digest(JSON.writeValueAsBytes(inventory)));
        return request;
    }

    public void begin(JsonNode request) throws IOException {
        validate(request);
        WorkspaceOperations operations = operations(request);
        String id = text(request, "operationId");
        byte[] bytes = JSON.writeValueAsBytes(request);
        var existing = operations.find(KIND, id, false);
        if (existing != null) {
            check(WorkspaceEvidenceResources.digest(bytes).equals(existing.get("request_digest")), "operation_conflict");
            return;
        }
        check(request.equals(plan(request)), "inventory_changed");
        transaction.executeWithoutResult(status -> {
            lock(request);
            requireRows(request);
            requireNoOtherOperations(request);
            check(jdbc.queryForList("SELECT 1 FROM ma_storage WHERE physical_key = ? AND fence_operation_id IS NOT NULL",
                    Integer.class, text(request, "physicalKey")).isEmpty(), "storage_fenced");
            operations.create(KIND, id, WorkspaceOperations.values("storage_id", text(request, "storageId"),
                    "state", "RETIRING", "phase", PHASE, "request_json", new String(bytes, java.nio.charset.StandardCharsets.UTF_8),
                    "request_digest", WorkspaceEvidenceResources.digest(bytes)));
            jdbc.update("UPDATE ma_storage SET fence_operation_id = ? WHERE physical_key = ?", id, text(request, "physicalKey"));
            check(jdbc.update("UPDATE ma_storage_owner SET mount_state = 'FENCED', mount_operation_id = ?,"
                    + " mount_completed_operation_id = NULL WHERE storage_key = ? AND mount_state = 'READY'"
                    + " AND mount_operation_id IS NULL", id, text(request, "physicalKey")) == 1, "owner_conflict");
        });
    }

    public void retire(JsonNode request, RuntimeBrokerOperations broker, RuntimeBindingRepository bindings,
            RuntimeProvisioner observer) throws IOException {
        requireReceipt(request);
        if ("COMPLETED".equals(operations(request).find(KIND, text(request, "operationId"), false).get("state"))) {
            return;
        }
        for (JsonNode alias : request.path("inventory").path("aliases")) {
            String after = null;
            while (true) {
                var page = bindings.findByStorage(alias.path("tenant_id").asText(), alias.path("storage_id").asText(), after, 50);
                for (var binding : page) {
                    requireFences(request);
                    if (binding.getState() != RuntimeBindingRecord.State.RELEASED) {
                        observeOriginal(request, binding, bindings, observer);
                        broker.recoverBinding(binding.getBindingId(), binding.getGeneration()).toCompletableFuture().join();
                    }
                    broker.retireStorageBinding(alias.path("tenant_id").asText(), alias.path("storage_id").asText(),
                            text(request, "operationId"), binding.getBindingId(), binding.getGeneration()).toCompletableFuture().join();
                    after = binding.getBindingId();
                }
                if (page.size() < 50) {
                    break;
                }
            }
        }
    }

    private static void observeOriginal(JsonNode request, RuntimeBindingRecord binding,
            RuntimeBindingRepository bindings, RuntimeProvisioner observer) {
        String owner = "reattest-" + text(request, "operationId");
        var claimed = bindings.claimOperation(binding.getBindingId(), owner, Duration.ofSeconds(30));
        check(claimed != null && claimed.getGeneration() == binding.getGeneration(), "runtime_claim_changed");
        try {
            var observation = observer.reconcile(claimed.getRequest(), claimed.getProvisionSeed(),
                    claimed.getResourceHandle(), claimed.getLease()).toCompletableFuture().orTimeout(15, java.util.concurrent.TimeUnit.SECONDS).join();
            check(observation.getOutcome() == RuntimeObservation.Outcome.NOT_FOUND && observation.getLossEvidence() != null
                    && observation.getStopEvidence() != null && observation.getLossEvidence().fact() == RuntimeRecoveryEvidence.Fact.JOURNAL_LOST
                    && observation.getStopEvidence().fact() == RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED
                    && observation.getLossEvidence().matches(claimed.getProvisionSeed(), claimed.getResourceHandle(), claimed.getLease())
                    && observation.getStopEvidence().matches(claimed.getProvisionSeed(), claimed.getResourceHandle(), claimed.getLease()), "original_boot_stop_unverified");
            check(bindings.compareAndSet(claimed, claimed.withRecoveryEvidence(observation.getLossEvidence(),
                    observation.getStopEvidence(), Instant.now())) != null, "runtime_claim_changed");
        } finally {
            bindings.releaseOperation(binding.getBindingId(), owner, claimed.getOperationGeneration());
        }
    }

    public void complete(JsonNode request) throws IOException {
        requireReceipt(request);
        String id = text(request, "operationId");
        var inventory = request.path("inventory");
        if ("COMPLETED".equals(operations(request).find(KIND, id, false).get("state"))) {
            verifyNew(request);
            verifyCommitted(request);
            return;
        }
        transaction.executeWithoutResult(status -> {
            lock(request);
            requireRows(request);
            requireIdle(request);
            requireFences(request);
        });
        for (JsonNode file : inventory.path("files")) {
            replace(file, id);
        }
        verifyNew(request);
        transaction.executeWithoutResult(status -> {
            lock(request);
            requireRows(request);
            requireIdle(request);
            requireFences(request);
            String previous = text(request, "physicalKey");
            String next = inventory.path("newPhysicalKey").asText();
            jdbc.update("UPDATE ma_storage_owner SET storage_key = ?, mount_device = ?,"
                    + " mount_revision = mount_revision + 1, mount_state = 'READY', mount_operation_id = NULL,"
                    + " mount_completed_operation_id = ? WHERE storage_key = ?", next,
                    inventory.path("identity").path("device").asText(), id, previous);
            jdbc.update("UPDATE ma_storage SET physical_key = ?, registration_revision = registration_revision + 1,"
                    + " fence_operation_id = NULL WHERE physical_key = ? AND fence_operation_id = ?", next, previous, id);
            for (JsonNode checkout : inventory.path("worktrees")) {
                check(jdbc.update("UPDATE ma_session_worktree SET physical_key = ?, plan_json = ?, identity_json = ?,"
                        + " state = 'READY', failure_code = NULL, revision = revision + 1"
                        + " WHERE tenant_id = ? AND session_id = ? AND physical_key = ? AND revision = ?",
                        next, checkout.path("new_plan_json").asText(), checkout.path("new_identity_json").asText(),
                        checkout.path("tenant_id").asText(), checkout.path("session_id").asText(), previous,
                        checkout.path("revision").asLong()) == 1, "worktree_conflict");
                check(jdbc.update("UPDATE ma_operation SET physical_key = ? WHERE operation_kind = 'SESSION_WORKTREE'"
                        + " AND tenant_id = ? AND operation_id = ? AND physical_key = ?", next,
                        checkout.path("tenant_id").asText(), checkout.path("operation_id").asText(), previous) == 1, "worktree_operation_conflict");
            }
            for (String state : List.of("RETIRED", "PREPARING", "PREPARED", "COMPLETED")) {
                operations(request).update(KIND, id, WorkspaceOperations.values("state", state, "phase", PHASE));
            }
        });
        verifyCommitted(request);
    }

    private void verifyCommitted(JsonNode request) {
        var inventory = request.path("inventory");
        String next = inventory.path("newPhysicalKey").asText();
        String previous = text(request, "physicalKey");
        check(jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE storage_key = ?"
                + " AND mount_state = 'READY' AND mount_operation_id IS NULL AND mount_completed_operation_id = ?"
                + " AND mount_device = ? AND mount_revision = ?", Integer.class, next, text(request, "operationId"),
                inventory.path("identity").path("device").asText(), inventory.path("owner").path("mount_revision").asLong() + 1).size() == 1,
                "committed_owner_changed");
        check(jdbc.queryForList("SELECT 1 FROM ma_storage WHERE physical_key = ?", Integer.class, previous).isEmpty(), "committed_alias_changed");
        var expectedAliases = inventory.path("aliases").deepCopy();
        for (JsonNode alias : expectedAliases) {
            ((ObjectNode) alias).put("physical_key", next).put("registration_revision", alias.path("registration_revision").asLong() + 1);
        }
        check(expectedAliases.equals(aliases(next)), "committed_alias_changed");
        for (JsonNode checkout : inventory.path("worktrees")) {
            check(jdbc.queryForList("SELECT 1 FROM ma_session_worktree WHERE tenant_id = ? AND session_id = ?"
                    + " AND physical_key = ? AND state = 'READY' AND revision = ? AND plan_json = ? AND identity_json = ?", Integer.class,
                    checkout.path("tenant_id").asText(), checkout.path("session_id").asText(), next,
                    checkout.path("revision").asLong() + 1, checkout.path("new_plan_json").asText(), checkout.path("new_identity_json").asText()).size() == 1,
                    "committed_worktree_changed");
            check(jdbc.queryForList("SELECT 1 FROM ma_operation WHERE operation_kind = 'SESSION_WORKTREE' AND tenant_id = ?"
                    + " AND operation_id = ? AND physical_key = ?", Integer.class, checkout.path("tenant_id").asText(),
                    checkout.path("operation_id").asText(), next).size() == 1, "committed_worktree_changed");
        }
    }

    private void requireRows(JsonNode request) {
        var inventory = request.path("inventory");
        String physical = text(request, "physicalKey");
        var owners = WorkspaceOperations.rows(jdbc, "SELECT tenant_id, storage_id, mount_root, mount_host_id,"
                + " mount_device, mount_inode, mount_birth_time, mount_registration_id, mount_revision"
                + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE", physical);
        check(owners.size() == 1 && inventory.path("owner").equals(JSON.valueToTree(owners.getFirst())), "owner_changed");
        requireOnlyOwner(inventory.path("owner"), physical);
        check(inventory.path("aliases").equals(aliases(physical)), "aliases_changed");
        var expected = inventory.path("worktrees").deepCopy();
        for (JsonNode checkout : expected) {
            ((ObjectNode) checkout).remove(List.of("new_plan_json", "new_identity_json"));
        }
        check(expected.equals(checkoutRows(physical)), "worktrees_changed");
    }

    private JsonNode aliases(String physical) {
        return JSON.valueToTree(WorkspaceOperations.rows(jdbc, "SELECT alias_key, tenant_id, storage_id, physical_key,"
                + " storage_kind, registration_state, registration_revision FROM ma_storage WHERE physical_key = ? ORDER BY alias_key", physical));
    }

    private JsonNode checkoutRows(String physical) {
        return JSON.valueToTree(WorkspaceOperations.rows(jdbc, "SELECT tenant_id, session_id, storage_id, worktree_id,"
                + " state, revision, plan_json, identity_json, operation_id, failure_code FROM ma_session_worktree"
                + " WHERE physical_key = ? AND state <> 'REMOVED' ORDER BY tenant_id, session_id", physical));
    }

    private static boolean hasAlias(JsonNode inventory, String tenant, String storage) {
        for (JsonNode alias : inventory.path("aliases")) {
            if (tenant.equals(alias.path("tenant_id").asText()) && storage.equals(alias.path("storage_id").asText())
                    && "LOCAL".equals(alias.path("storage_kind").asText()) && "REGISTERED".equals(alias.path("registration_state").asText())) {
                return true;
            }
        }
        return false;
    }

    private void requireOnlyOwner(JsonNode owner, String physical) {
        Path root = Path.of(owner.path("mount_root").asText());
        for (var other : WorkspaceOperations.rows(jdbc, "SELECT storage_key, mount_root FROM ma_storage_owner"
                + " WHERE mount_host_id = ? AND storage_kind IN ('LOCAL', 'SSH_LOCAL')", owner.path("mount_host_id").asText())) {
            if (!physical.equals(other.get("storage_key")) && other.get("mount_root") instanceof String path) {
                check(!root.startsWith(Path.of(path)) && !Path.of(path).startsWith(root), "overlapping_owner");
            }
        }
    }

    private void requireNoOtherOperations(JsonNode request) {
        for (var operation : WorkspaceOperations.rows(jdbc, "SELECT operation_kind, state, operation_id FROM ma_operation"
                + " WHERE physical_key = ?", text(request, "physicalKey"))) {
            String kind = (String) operation.get("operation_kind");
            String state = (String) operation.get("state");
            check(KIND.name().equals(kind) && text(request, "operationId").equals(operation.get("operation_id"))
                    || "SESSION_WORKTREE".equals(kind) && Set.of("READY", "REMOVED").contains(state)
                    || !"SESSION_WORKTREE".equals(kind) && Set.of("COMPLETED", "ABORTED", "MERGED", "DISCARDED", "RELEASED", "VERIFIED", "SEALED").contains(state),
                    "operation_unsettled");
        }
    }

    private void requireIdle(JsonNode request) {
        String physical = text(request, "physicalKey");
        check(jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE storage_key = ? AND (holder_key IS NOT NULL"
                + " OR binding_id IS NOT NULL OR runtime_generation IS NOT NULL OR runtime_session_id IS NOT NULL"
                + " OR member_count <> 0 OR maintenance_id IS NOT NULL)", Integer.class, physical).isEmpty(), "writers_active");
        check(jdbc.queryForList("SELECT 1 FROM ma_runtime_session WHERE execution_storage_key = ?", Integer.class, physical).isEmpty(), "writers_active");
        for (JsonNode alias : request.path("inventory").path("aliases")) {
            check(jdbc.queryForList("SELECT 1 FROM ma_runtime_binding WHERE storage_alias_key = ?"
                    + " AND (binding_state <> 'RELEASED' OR (stop_evidence_json IS NULL AND drain_receipt_json IS NULL))",
                    Integer.class, alias.path("alias_key").asText()).isEmpty(), "runtime_not_retired");
            check(jdbc.queryForList("SELECT 1 FROM ma_session_head h JOIN ma_workspace w ON w.tenant_id = h.tenant_id"
                    + " AND w.workspace_id = h.workspace_id WHERE w.tenant_id = ? AND w.storage_id = ?"
                    + " AND h.state = 'ACTIVE' AND (h.writer_lease_until IS NULL OR h.writer_lease_until > ?)", Integer.class, alias.path("tenant_id").asText(),
                    alias.path("storage_id").asText(), System.currentTimeMillis()).isEmpty(), "journal_writer_active");
            check(jdbc.queryForList("SELECT 1 FROM ma_session s JOIN ma_turn t ON t.tenant_id = s.tenant_id"
                    + " AND t.session_id = s.session_id WHERE s.tenant_id = ? AND s.workspace_storage_id = ?"
                    + " AND t.status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                    + " AND NOT (t.status = 'RUNNING' AND COALESCE(t.error_code, '') = 'hosted_harness_recovery_blocked'"
                    + " AND t.is_submission_attempted = TRUE)", Integer.class,
                    alias.path("tenant_id").asText(), alias.path("storage_id").asText()).isEmpty(), "turn_active");
            check(jdbc.queryForList("SELECT 1 FROM ma_operation o JOIN ma_session s ON s.tenant_id = o.tenant_id"
                    + " AND s.session_id = o.session_id WHERE s.tenant_id = ? AND s.workspace_storage_id = ?"
                    + " AND o.operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE', 'ACTION_RESPONSE', 'CWD_CHANGE', 'TASK_CANCEL')"
                    + " AND o.state NOT IN ('COMPLETED', 'FAILED')", Integer.class,
                    alias.path("tenant_id").asText(), alias.path("storage_id").asText()).isEmpty(), "session_operation_active");
            check(jdbc.queryForList("SELECT 1 FROM ma_request_receipt r JOIN ma_session s ON s.tenant_id = r.tenant_id"
                    + " AND s.session_id = r.session_id WHERE s.tenant_id = ? AND s.workspace_storage_id = ?"
                    + " AND r.namespace = 'SESSION_COMMAND' AND r.state = 'PENDING'", Integer.class,
                    alias.path("tenant_id").asText(), alias.path("storage_id").asText()).isEmpty(), "session_command_active");
        }
        requireNoOtherOperations(request);
    }

    private void lock(JsonNode request) {
        for (JsonNode alias : request.path("inventory").path("aliases")) {
            WorkspaceStorageKindGuard.lockDomain(jdbc, alias.path("tenant_id").asText());
            jdbc.queryForList("SELECT alias_key FROM ma_storage WHERE alias_key = ? FOR UPDATE", alias.path("alias_key").asText());
        }
        WorkspaceStorageKindGuard.lockDomain(jdbc, "local-storage-host/" + text(request, "hostId"));
    }

    private void requireFences(JsonNode request) {
        String physical = text(request, "physicalKey");
        String id = text(request, "operationId");
        check(jdbc.queryForList("SELECT 1 FROM ma_storage WHERE physical_key = ? AND (fence_operation_id IS NULL OR fence_operation_id <> ?)",
                Integer.class, physical, id).isEmpty(), "fence_changed");
        check(jdbc.queryForList("SELECT 1 FROM ma_storage_owner WHERE storage_key = ? AND mount_state = 'FENCED' AND mount_operation_id = ?",
                Integer.class, physical, id).size() == 1, "fence_changed");
    }

    private void requireReceipt(JsonNode request) throws IOException {
        validate(request);
        var saved = operations(request).find(KIND, text(request, "operationId"), false);
        check(saved != null && WorkspaceEvidenceResources.digest(JSON.writeValueAsBytes(request)).equals(saved.get("request_digest")), "operation_conflict");
    }

    private void verifyNew(JsonNode request) throws IOException {
        var inventory = request.path("inventory");
        Identity expected = JSON.treeToValue(inventory.path("identity"), Identity.class);
        check(expected.equals(identities.read(Path.of(expected.root()))), "identity_changed");
        for (JsonNode file : inventory.path("files")) {
            check(Arrays.equals(read(Path.of(file.path("path").asText())), decode(file, "after")), "marker_changed");
        }
        for (JsonNode checkout : inventory.path("worktrees")) {
            worktrees.verify(JSON.readValue(checkout.path("new_plan_json").asText(), Plan.class), checkout.path("new_identity_json").asText());
        }
    }

    private static void requireCompletedCheckout(JsonNode checkout) {
        check("READY".equals(checkout.path("state").asText())
                || "BLOCKED".equals(checkout.path("state").asText()) && "worktree_identity_conflict".equals(checkout.path("failure_code").asText()), "worktree_unsettled");
        check(checkout.path("identity_json").isTextual(), "worktree_unsettled");
    }

    private static void requireStableAnchors(Plan plan, String savedIdentity, String volumeUuid) throws IOException {
        String prefix = "macos-volume/1:" + volumeUuid + ":";
        JsonNode saved = JSON.readTree(savedIdentity);
        check(plan.rootIdentity().startsWith(prefix) && plan.commonIdentity().startsWith(prefix)
                && saved.path("target").asText().startsWith(prefix)
                && saved.path("gitfile").asText().startsWith(prefix)
                && saved.path("gitdirIdentity").asText().startsWith(prefix), "worktree_identity_conflict");
    }

    private static void requireStable(JsonNode request, JsonNode owner, Identity current) {
        check(current.device().matches("[0-9a-f]{32}") && current.device().equals(text(request, "volumeUuid"))
                && current.hostId().equals(text(request, "hostId")) && current.hostId().equals(owner.path("mount_host_id").asText())
                && current.inode().equals(owner.path("mount_inode").asText())
                && current.birthTime().equals(owner.path("mount_birth_time").asText()), "identity_changed");
    }

    private static JsonNode change(Path path, byte[] before, byte[] after) {
        return JSON.createObjectNode().put("path", path.toString()).put("before", Base64.getEncoder().encodeToString(before))
                .put("after", Base64.getEncoder().encodeToString(after));
    }

    private static byte[] read(Path path) throws IOException {
        check(path.isAbsolute() && path.equals(path.toRealPath()) && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)
                && Files.size(path) <= 1024 * 1024, "marker_unavailable");
        return Files.readAllBytes(path);
    }

    private static byte[] decode(JsonNode file, String field) {
        return Base64.getDecoder().decode(file.path(field).asText());
    }

    private static void replace(JsonNode file, String id) throws IOException {
        Path path = Path.of(file.path("path").asText());
        byte[] current = read(path);
        byte[] next = decode(file, "after");
        if (Arrays.equals(current, next)) {
            return;
        }
        check(Arrays.equals(current, decode(file, "before")), "marker_changed");
        Path temporary = path.resolveSibling(path.getFileName() + "." + id + ".tmp");
        if (Files.exists(temporary, LinkOption.NOFOLLOW_LINKS)) {
            byte[] partial = read(temporary);
            check(((Number) Files.getAttribute(temporary, "unix:nlink", LinkOption.NOFOLLOW_LINKS)).intValue() == 1
                    && partial.length <= next.length && Arrays.equals(partial, Arrays.copyOf(next, partial.length)), "temporary_marker_changed");
            Files.delete(temporary);
        }
        {
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW,
                    StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                ByteBuffer bytes = ByteBuffer.wrap(next);
                while (bytes.hasRemaining()) {
                    channel.write(bytes);
                }
                channel.force(true);
            }
        }
        check(Arrays.equals(read(path), current), "marker_changed");
        Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        try (FileChannel directory = FileChannel.open(path.getParent(), StandardOpenOption.READ)) {
            directory.force(true);
        }
    }

    private WorkspaceOperations operations(JsonNode request) {
        return new WorkspaceOperations(jdbc, text(request, "tenantId"));
    }

    private static void validate(JsonNode request) {
        check(request.isObject() && TYPE.equals(request.path("type").asText()), "invalid_request");
        check(UUID.fromString(text(request, "operationId")).toString().equals(text(request, "operationId")), "invalid_request");
        for (String field : List.of("tenantId", "storageId", "hostId", "physicalKey", "volumeUuid")) {
            text(request, field);
        }
    }

    private static String text(JsonNode request, String field) {
        check(request.path(field).isTextual() && !request.path(field).asText().isBlank(), "invalid_request");
        return request.path(field).asText();
    }

    private static void check(boolean condition, String code) {
        if (!condition) {
            throw new IllegalStateException("Workspace identity re-attestation: " + code);
        }
    }
}
