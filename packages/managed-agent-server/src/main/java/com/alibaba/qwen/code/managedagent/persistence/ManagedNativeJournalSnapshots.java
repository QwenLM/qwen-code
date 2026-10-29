package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredTransaction;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** Immutable native replay images, independent of public message snapshots. */
@Repository
public class ManagedNativeJournalSnapshots {
    static final String MANIFEST_KIND = "managed-native-journal-snapshot";
    static final String PAGE_KIND = "managed-native-journal-snapshot-page";
    static final String FORMAT = "qwen-managed-native-session-snapshot/1";
    static final String PAYLOAD_FORMAT = "committed-prefix-v1";
    static final int MAX_PAGE_BYTES = 16 * 1024 * 1024;
    private static final String OWNER = "NATIVE_SNAPSHOT";
    private final JdbcTemplate jdbc;
    private final ManagedSessionStore sessions;
    private final ObjectMapper json;
    private final TransactionTemplate isolated;
    private final ToolPublicationRetentionStore retention;

    public ManagedNativeJournalSnapshots(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, ManagedSessionStore sessions, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.jdbc = jdbc;
        this.sessions = sessions;
        this.json = json;
        var manager = new DataSourceTransactionManager(jdbc.getDataSource());
        this.isolated = new TransactionTemplate(manager);
        this.isolated.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.isolated.setIsolationLevel(TransactionDefinition.ISOLATION_READ_COMMITTED);
        this.retention = new ToolPublicationRetentionStore(jdbc, manager);
    }

    public record PublishRequest(
            @NotBlank @Size(max = 512) String workspaceId,
            @NotBlank @Size(max = 512) String writerId,
            @Min(1) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER) long writerGeneration,
            @NotBlank @Size(max = 512) String snapshotId,
            @Min(1) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER) long expectedJournalRevision,
            @Min(0) @Max(ManagedSessionStoreModels.MAX_SAFE_COUNTER) long expectedCommittedSequence,
            @Pattern(regexp = "[0-9a-f]{64}") String expectedLastCommitDigest) { }

    public record Manifest(String format, String payloadFormat, String tenantId, String workspaceId,
            String sessionId, String snapshotId, long coveredJournalRevision, long committedSequence,
            String lastCommitDigest, long activationEpoch, String latestCheckpointResourceId,
            int storageVersion, long pageCount, long resourceCount, String lastPageDigest) { }

    public record Descriptor(Manifest snapshot, ToolResultResourceRef manifest, boolean replayed) { }

    public record Page(long journalRevision, String previousPageDigest, StoredTransaction transaction,
            List<CommitResource> resources) { }

    public record StoredPage(long journalRevision, ToolResultResourceRef resource, String bytesBase64) { }

    public record PageResult(List<StoredPage> pages, long nextRevision, boolean hasMore) { }

    public Descriptor publish(String tenant, String session, String token, PublishRequest request) {
        Basis basis = isolated.execute(status -> new Basis(sessions.lockSnapshotWriter(tenant, session, token, request),
                retention.read(tenant, session)));
        try {
            return isolated.execute(status -> build(tenant, session, token, request, basis));
        } finally {
            isolated.executeWithoutResult(status -> basis.lease().close());
        }
    }

    private record Basis(RestoreHead head, ToolPublicationRetentionStore.ReadLease lease) { }

    private Descriptor build(String tenant, String session, String token, PublishRequest request, Basis basis) {
        RestoreHead head = basis.head();
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String owner = ownerKey(scope, request.snapshotId());
        claim(tenant, request.workspaceId(), session, request.snapshotId());
        Descriptor existing = find(tenant, request.workspaceId(), session, token, request.snapshotId());
        if (existing != null) {
            require(matches(existing.snapshot(), request), "managed_session_snapshot_conflict");
            sessions.lockSnapshotWriter(tenant, session, token, request);
            return new Descriptor(existing.snapshot(), existing.manifest(), true);
        }
        byte[] claimed = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?", byte[].class,
                ManagedSessionStore.resourceKey(scope, manifestId(scope, request.snapshotId())));
        require(java.util.Arrays.equals(claimed, "{}".getBytes(StandardCharsets.UTF_8)), "managed_session_snapshot_corrupt");
        require(head.journalRevision() == request.expectedJournalRevision()
                && head.committedSequence() == request.expectedCommittedSequence()
                && Objects.equals(head.lastCommitDigest(), request.expectedLastCommitDigest()),
                "managed_session_head_conflict");
        require(head.journalRevision() > 0 && head.compactedThroughRevision() == 0
                && "READY".equals(head.recoveryStatus()), "managed_session_recovery_blocked");
        long revision = 0;
        long sequence = 0;
        long activation = 0;
        String commit = null;
        String checkpoint = null;
        String previousPage = null;
        while (revision < head.journalRevision()) {
            basis.lease().checkReadView();
            long after = revision;
            var batch = isolated.execute(status -> sessions.transactions(tenant, request.workspaceId(), session, token,
                    after, (int) Math.min(100, head.journalRevision() - after)));
            require(!batch.transactions().isEmpty(), "managed_session_journal_corrupt");
            for (StoredTransaction transaction : batch.transactions()) {
                require(transaction.journalRevision() == revision + 1
                        && transaction.journalRevision() <= head.journalRevision()
                        && Objects.equals(transaction.previousCommitDigest(), commit)
                        && transaction.activationEpoch() >= activation, "managed_session_journal_corrupt");
                require(revision == 0
                        ? "session.create".equals(transaction.operation()) && transaction.eventCount() == 0
                            && transaction.firstSequence() == 0 && transaction.lastSequence() == 0
                            && transaction.commitDigest() == null
                        : !"session.create".equals(transaction.operation()) && transaction.eventCount() > 0
                            && transaction.firstSequence() == sequence + 1
                            && transaction.lastSequence() == sequence + transaction.eventCount()
                            && transaction.commitDigest() != null, "managed_session_journal_corrupt");
                var resources = census(tenant, request.workspaceId(), session, token, transaction.journalRevision());
                Page page = new Page(transaction.journalRevision(), previousPage, transaction, resources);
                verifyPage(tenant, request.workspaceId(), session, token, owner, head.journalRevision(), page, true);
                byte[] bytes = encode(page);
                require(bytes.length <= MAX_PAGE_BYTES, "managed_session_snapshot_page_too_large");
                StoredResource stored = put(tenant, request.workspaceId(), session, PAGE_KIND, bytes);
                pin(scope, owner, head.journalRevision(), stored, transaction.journalRevision(), tenant,
                        request.workspaceId(), session);
                previousPage = stored.digest();
                revision = transaction.journalRevision();
                sequence = transaction.lastSequence();
                activation = transaction.activationEpoch();
                commit = transaction.commitDigest();
                if (transaction.latestCheckpointResourceId() != null) {
                    checkpoint = transaction.latestCheckpointResourceId();
                }
            }
        }
        require(sequence == head.committedSequence() && activation == head.activationEpoch()
                && Objects.equals(commit, head.lastCommitDigest())
                && Objects.equals(checkpoint, head.latestCheckpointResourceId()), "managed_session_journal_corrupt");
        long resourceCount = jdbc.queryForObject("SELECT COUNT(DISTINCT resource_key) FROM ma_resource_ref"
                + " WHERE session_scope_key = ? AND owner_kind = 'JOURNAL' AND owner_key = ?"
                + " AND owner_revision = journal_revision AND journal_revision <= ?", Long.class, scope, scope, revision);
        Manifest manifest = new Manifest(FORMAT, PAYLOAD_FORMAT, tenant, request.workspaceId(), session,
                request.snapshotId(), revision, sequence, commit, activation, checkpoint,
                head.storageVersion(), revision, resourceCount, previousPage);
        byte[] manifestBytes = encode(manifest);
        String id = manifestId(scope, request.snapshotId());
        StoredResource stored = new StoredResource(id, MANIFEST_KIND, 1, manifestBytes.length,
                DigestUtils.sha256Hex(manifestBytes), manifestBytes);
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ?, kind = ? WHERE resource_key = ?",
                manifestBytes, manifestBytes.length, stored.digest(), MANIFEST_KIND, ManagedSessionStore.resourceKey(scope, id));
        basis.lease().checkReadView();
        RestoreHead current = sessions.lockSnapshotWriter(tenant, session, token, request);
        require(current.journalRevision() == request.expectedJournalRevision()
                && current.committedSequence() == request.expectedCommittedSequence()
                && Objects.equals(current.lastCommitDigest(), request.expectedLastCommitDigest()), "managed_session_head_conflict");
        String copy = "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision,"
                + " resource_key, tenant_id, workspace_id, session_id, resource_id, journal_revision, gmt_create)"
                + " SELECT ?, 'NATIVE_SNAPSHOT', ?, ?, resource_key, ?, ?, ?, resource_id, MIN(journal_revision), "
                + ManagedSchemaTime.SQL_NOW + " FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'JOURNAL'"
                + " AND owner_key = ? AND owner_revision = journal_revision AND journal_revision <= ?"
                + " GROUP BY resource_key, resource_id";
        // This setter bypasses schema coercion; binary identities are bound explicitly.
        var arguments = new org.springframework.jdbc.core.ArgumentPreparedStatementSetter(new Object[] {
                scope, owner, revision, ManagedSchemaKeys.identity(tenant), ManagedSchemaKeys.identity(request.workspaceId()),
                ManagedSchemaKeys.identity(session), scope, scope, revision
        });
        int copied = jdbc.update(copy, statement -> {
            statement.setQueryTimeout(2);
            arguments.setValues(statement);
        });
        require(copied == resourceCount, "managed_session_snapshot_corrupt");
        pin(scope, owner, revision, stored, null, tenant, request.workspaceId(), session);
        sessions.lockSnapshotWriter(tenant, session, token, request);
        return new Descriptor(manifest, ref(stored), false);
    }

    public Descriptor select(String tenant, String workspace, String session, String token, RestoreHead frozen) {
        RestoreHead current = sessions.restore(tenant, workspace, session, token);
        require(current.writerGeneration() == frozen.writerGeneration()
                && current.journalRevision() >= frozen.journalRevision(), "managed_session_writer_conflict");
        if (!"ACTIVE".equals(frozen.state()) || !"READY".equals(frozen.recoveryStatus())
                || frozen.compactedThroughRevision() != 0 || frozen.journalRevision() == 0) {
            return null;
        }
        var candidates = jdbc.query("SELECT owner_key, owner_revision FROM ma_resource_ref"
                + " WHERE session_scope_key = ? AND owner_kind = 'NATIVE_SNAPSHOT' AND owner_revision <= ?"
                + " GROUP BY owner_key, owner_revision ORDER BY owner_revision DESC, owner_key LIMIT 1",
                (row, index) -> new Candidate(row.getString(1), row.getLong(2)),
                ManagedSessionStore.sessionScopeKey(tenant, session), frozen.journalRevision());
        if (candidates.isEmpty()) {
            return null;
        }
        Candidate selected = candidates.getFirst();
        var roots = jdbc.queryForList("SELECT r.resource_id FROM ma_resource_ref f"
                + " JOIN ma_resource r ON r.resource_key = f.resource_key WHERE f.session_scope_key = ?"
                + " AND f.owner_kind = 'NATIVE_SNAPSHOT' AND f.owner_key = ? AND f.owner_revision = ? AND r.kind = ?",
                String.class, ManagedSessionStore.sessionScopeKey(tenant, session), selected.ownerKey(),
                selected.coverage(), MANIFEST_KIND);
        require(roots.size() == 1, "managed_session_snapshot_corrupt");
        String root = roots.getFirst();
        Manifest manifest = decode(resource(tenant, workspace, session, root, token).bytes(), Manifest.class);
        require(manifest.snapshotId() != null, "managed_session_snapshot_corrupt");
        Descriptor descriptor = read(tenant, workspace, session, token, manifest.snapshotId());
        require(root.equals(descriptor.manifest().resourceId())
                && selected.ownerKey().equals(ownerKey(ManagedSessionStore.sessionScopeKey(tenant, session), manifest.snapshotId()))
                && selected.coverage() == descriptor.snapshot().coveredJournalRevision()
                && descriptor.snapshot().committedSequence() <= frozen.committedSequence()
                && descriptor.snapshot().activationEpoch() <= frozen.activationEpoch()
                && descriptor.snapshot().storageVersion() <= frozen.storageVersion(), "managed_session_snapshot_corrupt");
        require(sessions.restore(tenant, workspace, session, token).writerGeneration() == frozen.writerGeneration(),
                "managed_session_writer_conflict");
        String id = descriptor.snapshot().snapshotId();
        if (".".equals(id) || "..".equals(id) || id.contains("/") || id.contains("\\")) {
            return null;
        }
        return descriptor;
    }

    private record Candidate(String ownerKey, long coverage) { }

    public Descriptor read(String tenant, String workspace, String session, String token, String snapshotId) {
        sessions.restore(tenant, workspace, session, token);
        Descriptor descriptor = find(tenant, workspace, session, token, snapshotId);
        if (descriptor == null) {
            throw new ManagedAgentException(HttpStatus.NOT_FOUND, "managed_session_snapshot_not_found",
                    "The native journal snapshot does not exist.");
        }
        sessions.restore(tenant, workspace, session, token);
        return descriptor;
    }

    public PageResult pages(String tenant, String workspace, String session, String token,
            String snapshotId, long afterRevision, int limit) {
        Descriptor descriptor = read(tenant, workspace, session, token, snapshotId);
        Manifest manifest = descriptor.snapshot();
        require(afterRevision >= 0 && afterRevision <= manifest.coveredJournalRevision()
                && limit >= 1 && limit <= 100, "invalid_managed_session_store_request");
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String owner = ownerKey(scope, snapshotId);
        List<StoredPage> result = new ArrayList<>();
        int bytes = 0;
        String previous = afterRevision == 0 ? null
                : pageResource(tenant, workspace, session, token, scope, owner,
                        manifest.coveredJournalRevision(), afterRevision).digest();
        long next = afterRevision;
        while (next < manifest.coveredJournalRevision() && result.size() < limit) {
            StoredResource resource = pageResource(tenant, workspace, session, token, scope, owner,
                    manifest.coveredJournalRevision(), next + 1);
            if (!result.isEmpty() && bytes + resource.byteLength() > MAX_PAGE_BYTES) {
                break;
            }
            Page page = decode(resource.bytes(), Page.class);
            require(page.journalRevision() == next + 1 && page.transaction() != null
                    && page.transaction().journalRevision() == next + 1
                    && Objects.equals(page.previousPageDigest(), previous), "managed_session_snapshot_corrupt");
            verifyPage(tenant, workspace, session, token, owner, manifest.coveredJournalRevision(), page, false);
            result.add(new StoredPage(++next, ref(resource), Base64.getEncoder().encodeToString(resource.bytes())));
            bytes += resource.bytes().length;
            previous = resource.digest();
        }
        if (next == manifest.coveredJournalRevision()) {
            require(Objects.equals(previous, manifest.lastPageDigest()), "managed_session_snapshot_corrupt");
        }
        sessions.restore(tenant, workspace, session, token);
        return new PageResult(List.copyOf(result), next, next < manifest.coveredJournalRevision());
    }

    private Descriptor find(String tenant, String workspace, String session, String token, String id) {
        require(id != null && !id.isBlank() && id.getBytes(StandardCharsets.UTF_8).length <= 512,
                "invalid_managed_session_store_request");
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String owner = ownerKey(scope, id);
        List<String> roots = jdbc.queryForList("SELECT f.resource_id FROM ma_resource_ref f JOIN ma_resource r"
                + " ON r.resource_key = f.resource_key WHERE f.session_scope_key = ? AND f.owner_kind = ?"
                + " AND f.owner_key = ? AND r.kind = ?", String.class, scope, OWNER, owner, MANIFEST_KIND);
        if (roots.isEmpty()) {
            require(pinCount(scope, owner, null) == 0, "managed_session_snapshot_corrupt");
            return null;
        }
        require(roots.size() == 1, "managed_session_snapshot_corrupt");
        StoredResource root = resource(tenant, workspace, session, roots.getFirst(), token);
        require(root.resourceId().equals(manifestId(scope, id)) && root.schemaVersion() == 1,
                "managed_session_snapshot_corrupt");
        Manifest manifest = decode(root.bytes(), Manifest.class);
        require(FORMAT.equals(manifest.format()) && PAYLOAD_FORMAT.equals(manifest.payloadFormat())
                && tenant.equals(manifest.tenantId()) && workspace.equals(manifest.workspaceId())
                && session.equals(manifest.sessionId()) && id.equals(manifest.snapshotId())
                && manifest.coveredJournalRevision() > 0 && manifest.pageCount() == manifest.coveredJournalRevision()
                && manifest.resourceCount() >= 0
                && pinCount(scope, owner, manifest.coveredJournalRevision())
                    == manifest.pageCount() + manifest.resourceCount() + 1, "managed_session_snapshot_corrupt");
        return new Descriptor(manifest, ref(root), false);
    }

    private List<CommitResource> census(String tenant, String workspace, String session, String token, long revision) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        List<String> ids = jdbc.queryForList("SELECT resource_id FROM ma_resource_ref WHERE session_scope_key = ?"
                + " AND owner_kind = 'JOURNAL' AND owner_key = ? AND owner_revision = ?"
                + " AND journal_revision = ? ORDER BY resource_id", String.class, scope, scope, revision, revision);
        require(ids.size() <= ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION, "managed_session_journal_corrupt");
        List<CommitResource> result = new ArrayList<>();
        for (String id : ids) {
            StoredResource resource = resource(tenant, workspace, session, id, token);
            require(!isSnapshotKind(resource.kind()), "managed_session_journal_corrupt");
            result.add(new CommitResource(id, resource.kind(), resource.schemaVersion(),
                    resource.byteLength(), resource.digest(), null));
        }
        return List.copyOf(result);
    }

    private void verifyPage(String tenant, String workspace, String session, String token,
            String owner, long coverage, Page page, boolean building) {
        require(page.resources() != null && page.resources().size() <= ManagedSessionStoreModels.MAX_RESOURCES_PER_TRANSACTION,
                "managed_session_snapshot_corrupt");
        Set<String> seen = new HashSet<>();
        for (CommitResource resource : page.resources()) {
            require(resource != null && resource.bytesBase64() == null, "managed_session_snapshot_corrupt");
            verifyReference(json.valueToTree(resource), tenant, workspace, session, token, owner, coverage,
                    page.journalRevision(), seen, building);
        }
        byte[] records;
        try {
            records = Base64.getDecoder().decode(page.transaction().recordBytesBase64());
        } catch (IllegalArgumentException error) {
            throw corrupt();
        }
        require(records.length <= ManagedSessionStoreModels.MAX_TRANSACTION_BYTES
                && records.length == page.transaction().byteLength()
                && DigestUtils.sha256Hex(records).equals(page.transaction().recordDigest()), "managed_session_snapshot_corrupt");
        for (String line : new String(records, StandardCharsets.UTF_8).split("\n")) {
            JsonNode record = decode(line.getBytes(StandardCharsets.UTF_8), JsonNode.class);
            JsonNode body = record.path("managedSession");
            String subtype = record.path("subtype").asText();
            if ("managed_session_header_v1".equals(subtype)) {
                for (String field : List.of("definitionRef", "rootSnapshotRef", "baseTranscriptProof")) {
                    verifyOptionalReference(body.get(field), tenant, workspace, session, token, owner, coverage,
                            page.journalRevision(), seen, building);
                }
            } else if ("managed_session_event_v1".equals(subtype)) {
                for (String field : eventReferenceFields(body.path("kind").asText())) {
                    JsonNode value = body.path("payload").get(field);
                    if (value != null && value.isArray()) {
                        for (JsonNode ref : value) {
                            verifyOptionalReference(ref, tenant, workspace, session, token, owner, coverage,
                                    page.journalRevision(), seen, building);
                        }
                    } else {
                        verifyOptionalReference(value, tenant, workspace, session, token, owner, coverage,
                                page.journalRevision(), seen, building);
                    }
                }
            }
        }
    }

    private void verifyOptionalReference(JsonNode ref, String tenant, String workspace, String session, String token,
            String owner, long coverage, long revision, Set<String> seen, boolean building) {
        if (ref != null && !ref.isNull()) {
            verifyReference(ref, tenant, workspace, session, token, owner, coverage, revision, seen, building);
        }
    }

    private static List<String> eventReferenceFields(String kind) {
        return switch (kind) {
            case "input.accepted" -> List.of("contentRef", "admissionRef");
            case "activation.changed" -> List.of("installRef", "boundaryRef");
            case "model.attempt" -> List.of("routeRef", "inputCheckpointRef", "usageRef", "recoveryRef");
            case "message.committed" -> List.of("contentRef");
            case "tool.intent" -> List.of("toolDefinitionRef", "argsRef");
            case "hosted.batch.planned" -> List.of("planRef");
            case "hosted.cleanup" -> List.of("descriptorRef");
            case "action.changed" -> List.of("optionsRef", "decisionRef");
            case "tool.receipt" -> List.of("toolOutcomeRef", "resultRef", "resources");
            case "checkpoint.committed" -> List.of("stateRef");
            case "context.compacted" -> List.of("summaryRef", "tokenCountsRef");
            case "turn.settled" -> List.of("resultRef", "usageRef", "pendingOwnersRef");
            case "config.bound" -> List.of("bundleRef", "rootSnapshotRef");
            case "lifecycle.changed" -> List.of("pendingOwnersRef");
            case "domain.committed", "operation.replayed" -> List.of("recordRef");
            default -> List.of();
        };
    }

    private static void collectReferences(JsonNode node, java.util.Collection<JsonNode> refs, int depth) {
        require(depth <= ManagedSessionStoreModels.MAX_JSON_DEPTH, "managed_session_snapshot_corrupt");
        if (node.isObject() && node.has("resourceId") && node.has("digest") && node.has("kind")) {
            refs.add(node);
            return;
        }
        for (JsonNode child : node) {
            collectReferences(child, refs, depth + 1);
        }
    }

    private void verifyReference(JsonNode reference, String tenant, String workspace, String session, String token,
            String owner, long coverage, long revision, Set<String> seen, boolean building) {
        var pending = new ArrayDeque<JsonNode>();
        pending.add(reference);
        while (!pending.isEmpty()) {
            JsonNode next = pending.removeFirst();
            String id = next.path("resourceId").asText();
            String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
            Long pinned = building
                    ? jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ?"
                            + " AND owner_kind = 'JOURNAL' AND owner_key = ? AND owner_revision = journal_revision"
                            + " AND resource_id = ? AND journal_revision > 0 AND journal_revision <= ?",
                            Long.class, scope, scope, id, revision)
                    : jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ?"
                            + " AND owner_kind = ? AND owner_key = ? AND owner_revision = ? AND resource_id = ?"
                            + " AND journal_revision > 0 AND journal_revision <= ?", Long.class,
                            scope, OWNER, owner, coverage, id, revision);
            require(pinned != null && (building ? pinned > 0 : pinned == 1), "managed_session_snapshot_resource_missing");
            StoredResource resource = resource(tenant, workspace, session, id, token);
            require(resource.kind().equals(next.path("kind").asText())
                    && resource.schemaVersion() == next.path("schemaVersion").asInt(-1)
                    && resource.byteLength() == next.path("byteLength").asLong(-1)
                    && resource.digest().equals(next.path("digest").asText()), "managed_session_snapshot_corrupt");
            if (seen.add(id) && structured(resource.kind())) {
                JsonNode body = decode(resource.bytes(), JsonNode.class);
                if (ManagedHostedRecoveryRecords.KINDS.contains(resource.kind()) || "managed-action-options".equals(resource.kind())) {
                    pending.addAll(ManagedHostedRecoveryRecords.references(body));
                } else {
                    collectReferences(body, pending, 0);
                }
            }
        }
    }

    private static boolean structured(String kind) {
        return kind.equals("managed-checkpoint") || kind.equals("managed-checkpoint-history")
                || kind.equals("managed-message-chunks") || kind.equals("managed-tool-result-manifest")
                || kind.equals("managed-tool-result-page") || kind.equals("managed-action-options")
                || ManagedHostedRecoveryRecords.KINDS.contains(kind)
                || ManagedExtensionRecords.DOMAINS.stream().anyMatch(domain -> kind.equals("managed-" + domain));
    }

    private StoredResource pageResource(String tenant, String workspace, String session, String token,
            String scope, String owner, long coverage, long revision) {
        List<String> ids = jdbc.queryForList("SELECT f.resource_id FROM ma_resource_ref f JOIN ma_resource r"
                + " ON r.resource_key = f.resource_key WHERE f.session_scope_key = ? AND f.owner_kind = ?"
                + " AND f.owner_key = ? AND f.owner_revision = ? AND f.journal_revision = ? AND r.kind = ?",
                String.class, scope, OWNER, owner, coverage, revision, PAGE_KIND);
        require(ids.size() == 1, "managed_session_snapshot_corrupt");
        StoredResource resource = resource(tenant, workspace, session, ids.getFirst(), token);
        require(resource.byteLength() <= MAX_PAGE_BYTES && resource.schemaVersion() == 1
                && resource.resourceId().equals(PAGE_KIND + ":" + resource.digest()), "managed_session_snapshot_corrupt");
        return resource;
    }

    private StoredResource put(String tenant, String workspace, String session, String kind, byte[] bytes) {
        String digest = DigestUtils.sha256Hex(bytes);
        String id = kind + ":" + digest;
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String key = ManagedSessionStore.resourceKey(scope, id);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                    + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', "
                    + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE resource_key = resource_key",
                key, scope, tenant, workspace, session, id, kind, bytes.length, digest, bytes);
        var rows = jdbc.queryForList("SELECT kind, sha256, inline_bytes, state, schema_version, storage_kind"
                + " FROM ma_resource WHERE resource_key = ?", key);
        require(rows.size() == 1 && kind.equals(rows.getFirst().get("kind"))
                && digest.equals(rows.getFirst().get("sha256")) && "REFERENCED".equals(rows.getFirst().get("state"))
                && "MYSQL_INLINE".equals(rows.getFirst().get("storage_kind"))
                && ((Number) rows.getFirst().get("schema_version")).intValue() == 1
                && java.util.Arrays.equals(bytes, (byte[]) rows.getFirst().get("inline_bytes")), "managed_session_snapshot_corrupt");
        return new StoredResource(id, kind, 1, bytes.length, digest, bytes);
    }

    private void claim(String tenant, String workspace, String session, String snapshotId) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String id = manifestId(scope, snapshotId);
        byte[] pending = "{}".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                + " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', "
                + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE resource_key = resource_key",
                ManagedSessionStore.resourceKey(scope, id), scope, tenant, workspace, session, id, MANIFEST_KIND,
                pending.length, DigestUtils.sha256Hex(pending), pending);
        var rows = jdbc.queryForList("SELECT tenant_id, workspace_id, session_id, resource_id, kind, schema_version,"
                + " storage_kind, state, object_key, object_version_id, encryption_key_id FROM ma_resource WHERE resource_key = ?",
                ManagedSessionStore.resourceKey(scope, id));
        require(rows.size() == 1 && tenant.equals(rows.getFirst().get("tenant_id"))
                && workspace.equals(rows.getFirst().get("workspace_id")) && session.equals(rows.getFirst().get("session_id"))
                && id.equals(rows.getFirst().get("resource_id")) && MANIFEST_KIND.equals(rows.getFirst().get("kind"))
                && ((Number) rows.getFirst().get("schema_version")).intValue() == 1
                && "MYSQL_INLINE".equals(rows.getFirst().get("storage_kind")) && "REFERENCED".equals(rows.getFirst().get("state"))
                && rows.getFirst().get("object_key") == null && rows.getFirst().get("object_version_id") == null
                && rows.getFirst().get("encryption_key_id") == null, "managed_session_snapshot_conflict");
    }

    private StoredResource resource(String tenant, String workspace, String session, String id, String token) {
        return isolated.execute(status -> sessions.readSnapshotResource(tenant, workspace, session, id, token));
    }

    private static String manifestId(String scope, String id) {
        return MANIFEST_KIND + ":" + ownerKey(scope, id);
    }

    private void pin(String scope, String owner, long coverage, StoredResource resource, Long revision,
            String tenant, String workspace, String session) {
        String key = ManagedSessionStore.resourceKey(scope, resource.resourceId());
        Long count = jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ?"
                + " AND owner_kind = ? AND owner_key = ? AND owner_revision = ? AND resource_key = ?",
                Long.class, scope, OWNER, owner, coverage, key);
        if (Long.valueOf(0).equals(count)) {
            jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key,"
                    + " tenant_id, workspace_id, session_id, resource_id, journal_revision, gmt_create)"
                    + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                    scope, OWNER, owner, coverage, key, tenant, workspace, session, resource.resourceId(), revision);
        }
    }

    private long pinCount(String scope, String owner, Long revision) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = ?"
                + " AND owner_key = ?" + (revision == null ? "" : " AND owner_revision = ?"), Long.class,
                revision == null ? new Object[] {scope, OWNER, owner} : new Object[] {scope, OWNER, owner, revision});
    }

    private byte[] encode(Object value) {
        try {
            return json.writeValueAsBytes(value);
        } catch (IOException error) {
            throw corrupt();
        }
    }

    private <T> T decode(byte[] bytes, Class<T> type) {
        try {
            T result = json.readValue(bytes, type);
            require(result != null, "managed_session_snapshot_corrupt");
            return result;
        } catch (IOException | IllegalArgumentException error) {
            throw corrupt();
        }
    }

    private static ToolResultResourceRef ref(StoredResource resource) {
        return new ToolResultResourceRef(resource.resourceId(), resource.kind(), resource.schemaVersion(),
                resource.byteLength(), resource.digest());
    }

    private static boolean matches(Manifest manifest, PublishRequest request) {
        return manifest.coveredJournalRevision() == request.expectedJournalRevision()
                && manifest.committedSequence() == request.expectedCommittedSequence()
                && Objects.equals(manifest.lastCommitDigest(), request.expectedLastCommitDigest());
    }

    static boolean isSnapshotKind(String kind) {
        return MANIFEST_KIND.equals(kind) || PAGE_KIND.equals(kind);
    }

    static boolean isSnapshotId(String id) {
        return id != null && (id.startsWith(MANIFEST_KIND + ":") || id.startsWith(PAGE_KIND + ":"));
    }

    private static String ownerKey(String scope, String id) {
        return ManagedSchemaKeys.key(scope, id);
    }

    private static void require(boolean condition, String code) {
        if (!condition) {
            throw new ManagedAgentException("invalid_managed_session_store_request".equals(code)
                    ? HttpStatus.BAD_REQUEST : HttpStatus.CONFLICT, code, "The native journal snapshot was refused.");
        }
    }

    private static ManagedAgentException corrupt() {
        return new ManagedAgentException(HttpStatus.CONFLICT, "managed_session_snapshot_corrupt",
                "The native journal snapshot is corrupt.");
    }
}
