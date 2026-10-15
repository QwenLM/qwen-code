package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ItemRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.HmacAlgorithms;
import org.apache.commons.codec.digest.HmacUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.security.GeneralSecurityException;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Immutable pages are built in one read view, then published in a short transaction. */
final class ManagedSnapshotStore {
    private static final java.security.SecureRandom CURSOR_RANDOM = new java.security.SecureRandom();
    static final long CURSOR_LIFETIME_MILLIS = 30 * 60 * 1000L;
    private static final int PAGE_ITEMS = 100;
    private static final int PAGE_BYTES = 128 * 1024;
    private static final TypeReference<List<SnapshotItem>> ITEMS = new TypeReference<>() {};
    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final TransactionTemplate view;
    private final TransactionTemplate publish;
    private final ToolPublicationRetentionStore retention;
    private final ItemReader items;

    ManagedSnapshotStore(JdbcTemplate jdbc, ObjectMapper mapper, Clock clock, ItemReader items) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.clock = clock;
        this.items = items;
        var manager =
                new DataSourceTransactionManager(
                        java.util.Objects.requireNonNull(jdbc.getDataSource()));
        view = new TransactionTemplate(manager);
        view.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        view.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        view.setReadOnly(true);
        retention = new ToolPublicationRetentionStore(jdbc, manager);
        publish = new TransactionTemplate(manager);
        publish.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    void afterCommit(String tenant, String session) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(
                    new TransactionSynchronization() {
                        @Override
                        public void afterCommit() {
                            build(tenant, session);
                        }
                    });
        } else {
            build(tenant, session);
        }
    }

    void build(String tenant, String session) {
        try (var lease = new SnapshotReadLease(tenant, session)) {
            Draft draft =
                    view.execute(
                            status -> {
                                List<Map<String, Object>> progress =
                                        jdbc.queryForList(
                                                "SELECT covered_sequence, projection_version FROM"
                                                    + " ma_event_stream WHERE tenant_id = ? AND"
                                                    + " session_id = ? AND stream_kind = 'SESSION'"
                                                    + " AND stream_id = X''",
                                                tenant,
                                                session);
                                if (progress.isEmpty()) {
                                    return null;
                                }
                                long sequence = number(progress.getFirst(), "covered_sequence");
                                int projection =
                                        (int) number(progress.getFirst(), "projection_version");
                                List<ItemRecord> rows = items.read(tenant, session, lease::check);
                                lease.check();
                                Map<String, String> bodyKeys = new java.util.HashMap<>();
                                jdbc.query(
                                        "SELECT item_id, body_resource_key FROM ma_message WHERE"
                                                + " tenant_id = ? AND session_id = ? AND"
                                                + " body_resource_key IS NOT NULL",
                                        (org.springframework.jdbc.core.RowCallbackHandler)
                                                row ->
                                                        bodyKeys.put(
                                                                row.getString("item_id"),
                                                                row.getString("body_resource_key")),
                                        tenant,
                                        session);
                                List<DraftPage> pages = new ArrayList<>();
                                List<SnapshotItem> page = new ArrayList<>();
                                int size = 2;
                                for (ItemRecord item : rows) {
                                    if (page.isEmpty()) {
                                        lease.check();
                                    }
                                    String body = bodyKeys.get(item.itemId());
                                    ItemRecord descriptor =
                                            body == null
                                                    ? item
                                                    : new ItemRecord(
                                                            item.tenantId(),
                                                            item.sessionId(),
                                                            item.itemId(),
                                                            item.turnId(),
                                                            item.type(),
                                                            item.role(),
                                                            item.status(),
                                                            item.attributes(),
                                                            item.firstSequence(),
                                                            item.lastSequence(),
                                                            item.createdAt(),
                                                            item.updatedAt(),
                                                            item.revision(),
                                                            List.of());
                                    SnapshotItem frozen = new SnapshotItem(descriptor, body);
                                    int itemSize = json(frozen).length;
                                    if (!page.isEmpty()
                                            && (page.size() >= PAGE_ITEMS
                                                    || size + itemSize > PAGE_BYTES)) {
                                        pages.add(draftPage(page));
                                        page = new ArrayList<>();
                                        size = 2;
                                    }
                                    page.add(frozen);
                                    size += itemSize + 1;
                                }
                                if (!page.isEmpty()) {
                                    pages.add(draftPage(page));
                                }
                                return new Draft(
                                        sequence,
                                        projection,
                                        rows.size(),
                                        List.copyOf(pages),
                                        List.copyOf(new java.util.HashSet<>(bodyKeys.values())));
                            });
            if (draft == null) {
                return;
            }
            lease.check();
            publish.executeWithoutResult(
                    status -> {
                        var sessions =
                                jdbc.queryForList(
                                        "SELECT retired_at, status FROM ma_session WHERE tenant_id"
                                            + " = ? AND session_id = ? AND session_kind = 'PUBLIC'"
                                            + " FOR UPDATE",
                                        tenant,
                                        session);
                        if (sessions.size() != 1
                                || sessions.getFirst().get("retired_at") != null
                                || "DELETED".equals(sessions.getFirst().get("status"))) {
                            return;
                        }
                        var streams =
                                jdbc.queryForList(
                                        "SELECT current_snapshot_id, covered_sequence,"
                                            + " projection_version FROM ma_event_stream WHERE"
                                            + " tenant_id = ? AND session_id = ? AND stream_kind ="
                                            + " 'SESSION' AND stream_id = X'' FOR UPDATE",
                                        tenant,
                                        session);
                        if (streams.isEmpty()
                                || number(streams.getFirst(), "projection_version")
                                        != draft.projection()) {
                            return;
                        }
                        Map<String, Object> stream = streams.getFirst();
                        List<Root> roots = current(tenant, session);
                        if (!roots.isEmpty()
                                && roots.getFirst().projection() == draft.projection()
                                && roots.getFirst().sequence() >= draft.sequence()) {
                            return;
                        }
                        long version = roots.isEmpty() ? 1 : roots.getFirst().version() + 1;
                        String id = UUID.randomUUID().toString();
                        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
                        String owner = ManagedSchemaKeys.key(scope, id);
                        long now = clock.millis();
                        for (String body : draft.bodies()) {
                            var available =
                                    jdbc.queryForList(
                                            "SELECT resource_id FROM ma_resource WHERE resource_key"
                                                + " = ? AND session_scope_key = ? AND state ="
                                                + " 'REFERENCED' AND deletion_operation_key IS NULL"
                                                + " FOR UPDATE",
                                            body,
                                            scope);
                            if (available.size() != 1) {
                                throw new IllegalStateException(
                                        "Snapshot body resource is no longer available");
                            }
                            jdbc.update(
                                    "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES (?, 'SNAPSHOT', ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                                    scope,
                                    owner,
                                    version,
                                    body,
                                    tenant,
                                    session,
                                    available.getFirst().get("resource_id"));
                        }
                        for (int page = 0; page < draft.pages().size(); page++) {
                            writeResource(
                                    tenant,
                                    session,
                                    scope,
                                    owner,
                                    version,
                                    pageId(id, page),
                                    "managed-snapshot-page",
                                    draft.pages().get(page).bytes(),
                                    new PageLocation(
                                            id,
                                            page,
                                            draft.pages().get(page).firstSequence(),
                                            draft.pages().get(page).lastSequence()));
                        }
                        byte[] manifest =
                                json(
                                        new Manifest(
                                                1,
                                                id,
                                                draft.sequence(),
                                                draft.projection(),
                                                draft.items(),
                                                draft.pages().size(),
                                                newCursorSecret()));
                        String manifestKey =
                                writeResource(
                                        tenant,
                                        session,
                                        scope,
                                        owner,
                                        version,
                                        "snapshot:" + id + ":manifest",
                                        "managed-snapshot-manifest",
                                        manifest);
                        jdbc.update(
                                "INSERT INTO ma_snapshot (tenant_id, session_id, snapshot_id,"
                                    + " snapshot_version, covered_sequence, projection_version,"
                                    + " manifest_resource_key, manifest_sha256, item_count, state,"
                                    + " gmt_create, published_at, retain_until) VALUES (?, ?, ?, ?,"
                                    + " ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?)",
                                tenant,
                                session,
                                id,
                                version,
                                draft.sequence(),
                                draft.projection(),
                                manifestKey,
                                WorkspaceEvidenceResources.digest(manifest),
                                draft.items(),
                                now,
                                now,
                                now + CURSOR_LIFETIME_MILLIS);
                        jdbc.update(
                                "UPDATE ma_event_stream SET current_snapshot_id = ?,"
                                    + " snapshot_stale_since = CASE WHEN covered_sequence > ? THEN"
                                    + " ? ELSE NULL END WHERE tenant_id = ? AND session_id = ? AND"
                                    + " stream_kind = 'SESSION' AND stream_id = X''",
                                id,
                                draft.sequence(),
                                now,
                                tenant,
                                session);
                        expire(tenant, session, id, now);
                    });
        }
    }

    Optional<SnapshotRecord> latest(String tenant, String session) {
        try (var lease = new SnapshotReadLease(tenant, session)) {
            Root root =
                    publish.execute(
                            status -> {
                                lockStream(tenant, session);
                                List<Root> roots = current(tenant, session);
                                if (roots.isEmpty()) {
                                    return null;
                                }
                                protect(roots.getFirst(), tenant, session);
                                return roots.getFirst();
                            });
            if (root == null) {
                return Optional.empty();
            }
            Optional<SnapshotRecord> result = view.execute(
                    status -> {
                        Manifest manifest = manifest(root, tenant, session);
                        List<ItemRecord> rows = new ArrayList<>();
                        for (int page = 0; page < manifest.pages(); page++) {
                            lease.check();
                            rows.addAll(readPage(tenant, session, root.id(), page));
                        }
                        lease.check();
                        if (rows.size() != manifest.items()) {
                            throw new IllegalStateException(
                                    "Snapshot item count differs from manifest");
                        }
                        return Optional.of(
                                new SnapshotRecord(
                                        tenant,
                                        session,
                                        root.version(),
                                        root.sequence(),
                                        List.copyOf(rows),
                                        root.created(),
                                        root.created()));
                    });
            lease.check();
            return result;
        }
    }

    Page page(String tenant, String session, String cursor, long afterSequence, int limit) {
        try (var lease = new SnapshotReadLease(tenant, session)) {
            Start start =
                    publish.execute(
                            status -> {
                                Root root;
                                Cursor position;
                                if (StringUtils.isBlank(cursor)) {
                                    lockStream(tenant, session);
                                    List<Root> roots = current(tenant, session);
                                    if (roots.isEmpty()) {
                                        return null;
                                    }
                                    root = roots.getFirst();
                                    long expires = protect(root, tenant, session);
                                    position =
                                            new Cursor(
                                                    1,
                                                    ManagedSessionStore.sessionScopeKey(
                                                            tenant, session),
                                                    root.id(),
                                                    root.version(),
                                                    root.projection(),
                                                    0,
                                                    0,
                                                    expires,
                                                    afterSequence);
                                } else {
                                    position = decode(cursor);
                                    if (position.version() != 1
                                            || position.scope() == null
                                            || !position.scope()
                                                    .equals(
                                                            ManagedSessionStore.sessionScopeKey(
                                                                    tenant, session))) {
                                        throw invalidCursor();
                                    }
                                    if (position.expires() <= clock.millis()) {
                                        throw expiredCursor();
                                    }
                                    var roots =
                                            jdbc.query(
                                                    "SELECT " + ManagedSchemaProjection.SNAPSHOT.columns() + " FROM ma_snapshot WHERE tenant_id = ?"
                                                        + " AND session_id = ? AND snapshot_id = ?"
                                                        + " AND state = 'PUBLISHED' AND"
                                                        + " retain_until >= ?",
                                                    (row, i) -> root(row),
                                                    tenant,
                                                    session,
                                                    position.snapshot(),
                                                    position.expires());
                                    if (roots.size() != 1) {
                                        throw expiredCursor();
                                    }
                                    root = roots.getFirst();
                                    if (root.version() != position.snapshotVersion()
                                            || root.projection() != position.projection()) {
                                        throw invalidCursor();
                                    }
                                }
                                return new Start(root, position);
                            });
            if (start == null) {
                return new Page(List.of(), false, null, 0);
            }
            Page result = view.execute(
                    status -> {
                        Root root = start.root();
                        Cursor position = start.cursor();
                        Manifest manifest = manifest(root, tenant, session);
                        if (StringUtils.isNotBlank(cursor)) {
                            verifyCursor(cursor, manifest);
                        }
                        if (position.page() < 0
                                || position.page() > manifest.pages()
                                || position.offset() < 0) {
                            throw invalidCursor();
                        }
                        int page = position.page();
                        int offset = position.offset();
                        if (StringUtils.isBlank(cursor)) {
                            List<Integer> starts =
                                    jdbc.query(
                                            "SELECT snapshot_page_ordinal FROM ma_resource WHERE"
                                                + " session_scope_key = ? AND snapshot_id = ? AND"
                                                + " snapshot_page_last_sequence > ? AND tenant_id ="
                                                + " ? AND session_id = ? AND kind = ? AND"
                                                + " schema_version = 1 AND storage_kind ="
                                                + " 'MYSQL_INLINE' AND state = 'REFERENCED' AND"
                                                + " deletion_operation_key IS NULL ORDER BY"
                                                + " snapshot_page_last_sequence,"
                                                + " snapshot_page_ordinal LIMIT 1",
                                            (row, index) -> row.getInt("snapshot_page_ordinal"),
                                            ManagedSessionStore.sessionScopeKey(tenant, session),
                                            root.id(),
                                            position.afterSequence(),
                                            tenant,
                                            session,
                                            "managed-snapshot-page");
                            if (starts.isEmpty()) {
                                lease.check();
                                return new Page(List.of(), false, null, root.sequence());
                            }
                            page = starts.getFirst();
                            if (page < 0 || page >= manifest.pages()) {
                                throw new IllegalStateException(
                                        "Snapshot page directory is inconsistent");
                            }
                        }
                        List<ItemRecord> selected = new ArrayList<>();
                        while (page < manifest.pages() && selected.size() < limit + 1) {
                            lease.check();
                            List<ItemRecord> rows = readPage(tenant, session, root.id(), page);
                            if (offset > rows.size()) {
                                throw invalidCursor();
                            }
                            while (offset < rows.size() && selected.size() < limit + 1) {
                                ItemRecord item = rows.get(offset++);
                                if (item.firstSequence() > position.afterSequence()) {
                                    selected.add(item);
                                }
                            }
                            if (offset == rows.size()) {
                                page++;
                                offset = 0;
                            }
                        }
                        boolean more = selected.size() > limit;
                        String next = null;
                        if (more) {
                            // The look-ahead item belongs to the next page request.
                            if (offset == 0) {
                                page--;
                                offset = readPage(tenant, session, root.id(), page).size();
                            }
                            offset--;
                            next =
                                    encode(
                                            new Cursor(
                                                    1,
                                                    position.scope(),
                                                    root.id(),
                                                    root.version(),
                                                    root.projection(),
                                                    page,
                                                    offset,
                                                    position.expires(),
                                                    position.afterSequence()),
                                            manifest);
                            selected.removeLast();
                        }
                        lease.check();
                        return new Page(List.copyOf(selected), more, next, root.sequence());
                    });
            lease.check();
            return result;
        }
    }

    @FunctionalInterface
    interface ItemReader {
        List<ItemRecord> read(String tenant, String session, Runnable checkLease);
    }

    private record Start(Root root, Cursor cursor) {}

    private final class SnapshotReadLease implements AutoCloseable {
        private final ToolPublicationRetentionStore.ReadLease lease;

        SnapshotReadLease(String tenant, String session) {
            // afterCommit callbacks still have the completed transaction bound to the thread.
            lease = publish.execute(status -> retention.read(tenant, session));
        }

        void check() {
            if (TransactionSynchronizationManager.isCurrentTransactionReadOnly()) {
                // A read view cannot commit a renewal; it must finish before the committed lease expires.
                lease.checkReadView();
            } else {
                publish.executeWithoutResult(status -> lease.check());
            }
        }

        @Override
        public void close() {
            publish.executeWithoutResult(status -> lease.close());
        }
    }

    private void lockStream(String tenant, String session) {
        jdbc.queryForList(
                "SELECT current_snapshot_id FROM ma_event_stream WHERE tenant_id = ? AND session_id"
                        + " = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR UPDATE",
                tenant,
                session);
    }

    private void expire(String tenant, String session, String current, long now) {
        var rows =
                jdbc.queryForList(
                        "SELECT snapshot_id, snapshot_version FROM ma_snapshot WHERE tenant_id = ?"
                            + " AND session_id = ? AND retain_until <= ? AND snapshot_id <> ? ORDER"
                            + " BY retain_until LIMIT 32 FOR UPDATE",
                        tenant,
                        session,
                        now,
                        current);
        for (var row : rows) {
            String id = (String) row.get("snapshot_id");
            ManagedProjectionResourceCollector.removeSnapshot(
                    jdbc, tenant, session, id, number(row, "snapshot_version"));
        }
    }

    private long protect(Root root, String tenant, String session) {
        long expires = clock.millis() + CURSOR_LIFETIME_MILLIS;
        jdbc.update(
                "UPDATE ma_snapshot SET retain_until = GREATEST(retain_until, ?) WHERE tenant_id ="
                        + " ? AND session_id = ? AND snapshot_id = ? AND state = 'PUBLISHED'",
                expires,
                tenant,
                session,
                root.id());
        return expires;
    }

    private List<Root> current(String tenant, String session) {
        return jdbc.query(
                "SELECT " + ManagedSchemaProjection.SNAPSHOT.columns("p") + " FROM ma_event_stream s JOIN ma_snapshot p ON p.tenant_id = s.tenant_id"
                    + " AND p.session_id = s.session_id AND p.snapshot_id = s.current_snapshot_id"
                    + " WHERE s.tenant_id = ? AND s.session_id = ? AND s.stream_kind = 'SESSION'"
                    + " AND s.stream_id = X'' AND p.state = 'PUBLISHED'",
                (row, i) -> root(row),
                tenant,
                session);
    }

    private Root root(java.sql.ResultSet row) throws java.sql.SQLException {
        return new Root(
                row.getString("snapshot_id"),
                row.getLong("snapshot_version"),
                row.getLong("covered_sequence"),
                row.getInt("projection_version"),
                row.getString("manifest_resource_key"),
                row.getString("manifest_sha256"),
                row.getLong("gmt_create"));
    }

    private Manifest manifest(Root root, String tenant, String session) {
        byte[] bytes = resource(root.manifest(), tenant, session, "managed-snapshot-manifest");
        if (!WorkspaceEvidenceResources.digest(bytes).equals(root.digest())) {
            throw new IllegalStateException("Snapshot manifest digest differs");
        }
        try {
            Manifest result = mapper.readValue(bytes, Manifest.class);
            if (result.version() != 1
                    || !result.snapshot().equals(root.id())
                    || result.sequence() != root.sequence()
                    || result.projection() != root.projection()
                    || result.pages() < 0
                    || result.items() < 0) {
                throw new IllegalStateException("Snapshot manifest scope differs");
            }
            return result;
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Snapshot manifest is invalid", error);
        }
    }

    private List<ItemRecord> readPage(String tenant, String session, String snapshot, int page) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        try {
            List<SnapshotItem> frozen =
                    mapper.readValue(
                            resource(
                                    ManagedSessionStore.resourceKey(scope, pageId(snapshot, page)),
                                    tenant,
                                    session,
                                    "managed-snapshot-page"),
                            ITEMS);
            List<ItemRecord> result = new ArrayList<>(frozen.size());
            for (SnapshotItem entry : frozen) {
                ItemRecord item = entry.item();
                if (entry.body() == null) {
                    result.add(item);
                } else {
                    var parts =
                            mapper.readValue(
                                    resource(
                                            entry.body(), tenant, session, "managed-message-parts"),
                                    new TypeReference<List<StoreModels.ItemPartRecord>>() {});
                    result.add(
                            new ItemRecord(
                                    item.tenantId(),
                                    item.sessionId(),
                                    item.itemId(),
                                    item.turnId(),
                                    item.type(),
                                    item.role(),
                                    item.status(),
                                    item.attributes(),
                                    item.firstSequence(),
                                    item.lastSequence(),
                                    item.createdAt(),
                                    item.updatedAt(),
                                    item.revision(),
                                    parts));
                }
            }
            return List.copyOf(result);
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Snapshot page is invalid", error);
        }
    }

    private byte[] resource(String key, String tenant, String session, String kind) {
        var rows =
                jdbc.query(
                        "SELECT inline_bytes, sha256, byte_length FROM ma_resource WHERE"
                            + " resource_key = ? AND session_scope_key = ? AND tenant_id = ? AND"
                            + " session_id = ? AND kind = ? AND schema_version = 1 AND state ="
                            + " 'REFERENCED' AND deletion_operation_key IS NULL",
                        (row, i) -> {
                            byte[] bytes = row.getBytes("inline_bytes");
                            if (bytes == null
                                    || bytes.length != row.getLong("byte_length")
                                    || !WorkspaceEvidenceResources.digest(bytes)
                                            .equals(row.getString("sha256"))) {
                                throw new IllegalStateException("Snapshot resource digest differs");
                            }
                            return bytes;
                        },
                        key,
                        ManagedSessionStore.sessionScopeKey(tenant, session),
                        tenant,
                        session,
                        kind);
        if (rows.size() != 1) {
            throw new IllegalStateException("Snapshot resource is unavailable");
        }
        return rows.getFirst();
    }

    private String writeResource(
            String tenant,
            String session,
            String scope,
            String owner,
            long version,
            String id,
            String kind,
            byte[] bytes) {
        return writeResource(tenant, session, scope, owner, version, id, kind, bytes, null);
    }

    private String writeResource(
            String tenant,
            String session,
            String scope,
            String owner,
            long version,
            String id,
            String kind,
            byte[] bytes,
            PageLocation page) {
        String key = ManagedSessionStore.resourceKey(scope, id);
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create, last_verified_at, snapshot_id, snapshot_page_ordinal, snapshot_page_first_sequence, snapshot_page_last_sequence) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ", ?, ?, ?, ?)",
                key,
                scope,
                tenant,
                session,
                id,
                kind,
                bytes.length,
                WorkspaceEvidenceResources.digest(bytes),
                bytes,
                page == null ? null : page.snapshot(),
                page == null ? null : page.ordinal(),
                page == null ? null : page.firstSequence(),
                page == null ? null : page.lastSequence());
        jdbc.update(
                "INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create) VALUES (?, 'SNAPSHOT', ?, ?, ?, ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                scope,
                owner,
                version,
                key,
                tenant,
                session,
                id);
        return key;
    }

    private DraftPage draftPage(List<SnapshotItem> items) {
        return new DraftPage(
                json(items),
                items.getFirst().item().firstSequence(),
                items.getLast().item().firstSequence());
    }

    private byte[] json(Object value) {
        try {
            return mapper.writeValueAsBytes(value);
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Snapshot cannot be serialized", error);
        }
    }

    private String encode(Cursor cursor, Manifest manifest) {
        byte[] payload = json(cursor);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload)
                + "."
                + Base64.getUrlEncoder()
                        .withoutPadding()
                        .encodeToString(cursorMac(payload, manifest.cursorSecret()));
    }

    private Cursor decode(String cursor) {
        try {
            if (cursor.length() > 4096 || cursor.indexOf('.') < 1) {
                throw invalidCursor();
            }
            return mapper.readValue(
                    Base64.getUrlDecoder().decode(cursor.substring(0, cursor.indexOf('.'))),
                    Cursor.class);
        } catch (java.io.IOException | IllegalArgumentException error) {
            throw invalidCursor();
        }
    }

    private void verifyCursor(String cursor, Manifest manifest) {
        try {
            int separator = cursor.indexOf('.');
            byte[] payload = Base64.getUrlDecoder().decode(cursor.substring(0, separator));
            byte[] signature = Base64.getUrlDecoder().decode(cursor.substring(separator + 1));
            if (!java.security.MessageDigest.isEqual(
                    signature, cursorMac(payload, manifest.cursorSecret()))) {
                throw invalidCursor();
            }
        } catch (IllegalArgumentException error) {
            throw invalidCursor();
        }
    }

    private static byte[] cursorMac(byte[] payload, String secret) {
        try {
            return new HmacUtils(HmacAlgorithms.HMAC_SHA_256,
                    Base64.getDecoder().decode(secret)).hmac(payload);
        } catch (IllegalArgumentException error) {
            if (error.getCause() instanceof GeneralSecurityException cause) {
                throw new IllegalStateException("Snapshot cursor signing is unavailable", cause);
            }
            throw error;
        }
    }

    private static String newCursorSecret() {
        byte[] bytes = new byte[32];
        CURSOR_RANDOM.nextBytes(bytes);
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static String pageId(String snapshot, int page) {
        return "snapshot:" + snapshot + ":page:" + page;
    }

    private static long number(Map<String, Object> row, String name) {
        return ((Number) row.get(name)).longValue();
    }

    private static ApiException invalidCursor() {
        return new ApiException(
                HttpStatus.BAD_REQUEST, "invalid_item_cursor", "The item cursor is invalid.");
    }

    private static ApiException expiredCursor() {
        return new ApiException(
                HttpStatus.CONFLICT, "cursor_expired", "The snapshot cursor has expired.");
    }

    record Page(List<ItemRecord> items, boolean hasMore, String nextCursor, long coveredSequence) {}

    private record Root(
            String id,
            long version,
            long sequence,
            int projection,
            String manifest,
            String digest,
            long created) {}

    private record Draft(
            long sequence, int projection, int items, List<DraftPage> pages, List<String> bodies) {}

    private record DraftPage(byte[] bytes, long firstSequence, long lastSequence) {}

    private record PageLocation(
            String snapshot, int ordinal, long firstSequence, long lastSequence) {}

    private record SnapshotItem(ItemRecord item, String body) {}

    private record Manifest(
            int version,
            String snapshot,
            long sequence,
            int projection,
            int items,
            int pages,
            String cursorSecret) {}

    private record Cursor(
            int version,
            String scope,
            String snapshot,
            long snapshotVersion,
            int projection,
            int page,
            int offset,
            long expires,
            long afterSequence) {}
}
