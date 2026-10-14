package db.migration;

import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecords.InvalidRecordException;
import com.alibaba.qwen.code.managedagent.store.ManagedHookRecords;
import com.alibaba.qwen.code.managedagent.store.ManagedHookRecords.AdmissionKeys;
import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Set;
import org.flywaydb.core.api.migration.BaseJavaMigration;
import org.flywaydb.core.api.migration.Context;

/**
 * Gives the Hook records written before V28 the admission projection that
 * the Session store now writes with each first revision. Each projection is
 * read from the record's committed body, verified as the store verifies a
 * resource it reads. A record that cannot be verified keeps no projection,
 * and its Session is blocked as a missing resource blocks it, so no later
 * admission can reuse a once key the record consumed. So does a record that
 * repeats a once key or an occurrence ordinal of its Session, which the
 * unique indexes would refuse. Other Sessions are unaffected.
 */
public class V29__managed_hook_admission_backfill extends BaseJavaMigration {
    // Rows read per query, so memory does not grow with the record count.
    private static final int PAGE_SIZE = 500;
    static final String BLOCKED_DETAIL = "hook_admission_record_unverified";
    static final String DUPLICATE_DETAIL = "hook_admission_record_duplicate";

    @Override
    public void migrate(Context context) throws Exception {
        Connection connection = context.getConnection();
        try (PreparedStatement select = connection.prepareStatement("SELECT"
                        + " record.session_scope_key, record.record_key,"
                        + " record.tenant_id, record.session_id,"
                        + " record.domain, resource.tenant_id AS resource_tenant,"
                        + " resource.session_id AS resource_session, resource.kind,"
                        + " resource.schema_version, resource.byte_length,"
                        + " resource.sha256, resource.storage_kind,"
                        + " resource.state, resource.inline_bytes,"
                        + " resource.object_key, resource.object_version_id,"
                        + " resource.encryption_key_id FROM"
                        + " qwen_managed_session_extension_record record"
                        + " LEFT JOIN qwen_managed_session_resource resource"
                        + " ON resource.session_scope_key ="
                        + " record.session_scope_key AND resource.resource_id"
                        + " = record.record_resource_id WHERE record.domain IN"
                        + " ('hook_registration', 'hook_execution') AND"
                        + " (record.session_scope_key > ? OR"
                        + " (record.session_scope_key = ? AND"
                        + " record.record_key > ?)) ORDER BY"
                        + " record.session_scope_key, record.record_key"
                        + " LIMIT ?");
                PreparedStatement update = connection.prepareStatement(
                        "UPDATE qwen_managed_session_extension_record SET"
                                + " hook_once_key_hash = ?,"
                                + " hook_occurrence_hash = ?, hook_ordinal = ?,"
                                + " hook_definition_hash = ? WHERE"
                                + " session_scope_key = ? AND record_key = ?");
                PreparedStatement block = connection.prepareStatement(
                        "UPDATE qwen_managed_session_journal_head SET"
                                + " recovery_status = 'BLOCKED_RESOURCE',"
                                + " recovery_detail_code = ?, updated_at = ?"
                                + " WHERE tenant_id = ? AND session_id = ?"
                                + " AND recovery_status = 'READY'")) {
            String scopeKey = "";
            String recordKey = "";
            // The unique keys given to the Session being read. Its rows are
            // read together, so this holds one Session's at a time.
            Set<String> given = new HashSet<>();
            int read;
            do {
                select.setString(1, scopeKey);
                select.setString(2, scopeKey);
                select.setString(3, recordKey);
                select.setInt(4, PAGE_SIZE);
                read = 0;
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) {
                        read++;
                        if (!rows.getString("session_scope_key").equals(scopeKey)) {
                            given.clear();
                        }
                        scopeKey = rows.getString("session_scope_key");
                        recordKey = rows.getString("record_key");
                        AdmissionKeys keys = keys(rows);
                        if (keys == null) {
                            block(block, rows, BLOCKED_DETAIL);
                            continue;
                        }
                        String once = keys.onceKeyHash() == null ? null
                                : "once " + keys.onceKeyHash();
                        String ordinal = keys.occurrenceHash() == null ? null
                                : "ordinal " + keys.occurrenceHash() + " "
                                        + keys.ordinal();
                        if (given.contains(once) || given.contains(ordinal)) {
                            block(block, rows, DUPLICATE_DETAIL);
                            continue;
                        }
                        if (once != null) {
                            given.add(once);
                        }
                        if (ordinal != null) {
                            given.add(ordinal);
                        }
                        update.setString(1, keys.onceKeyHash());
                        update.setString(2, keys.occurrenceHash());
                        if (keys.ordinal() == null) {
                            update.setNull(3, Types.BIGINT);
                        } else {
                            update.setLong(3, keys.ordinal());
                        }
                        update.setString(4, keys.definitionHash());
                        update.setString(5, scopeKey);
                        update.setString(6, recordKey);
                        update.addBatch();
                    }
                }
                update.executeBatch();
                update.clearBatch();
            } while (read == PAGE_SIZE);
        }
    }

    private static void block(PreparedStatement block, ResultSet row,
            String detail) throws SQLException {
        block.setString(1, detail);
        block.setTimestamp(2, Timestamp.from(Instant.now()));
        block.setString(3, row.getString("tenant_id"));
        block.setString(4, row.getString("session_id"));
        block.executeUpdate();
    }

    /** The keys of a verified record body, or null when it cannot be verified. */
    private static AdmissionKeys keys(ResultSet row) throws SQLException {
        String domain = row.getString("domain");
        byte[] bytes = row.getBytes("inline_bytes");
        // Only rows written before the admission index existed reach this,
        // and admission had already checked each of them for everything
        // this checks (ManagedSessionStore.storedResource and
        // ManagedExtensionRecordStore.apply). Never check more than that,
        // including in the parser and validator called below: a stricter
        // check would block Sessions whose records are valid.
        if (bytes == null || !"REFERENCED".equals(row.getString("state"))
                || !row.getString("tenant_id").equals(row.getString("resource_tenant"))
                || !row.getString("session_id").equals(row.getString("resource_session"))
                || !"MYSQL_INLINE".equals(row.getString("storage_kind"))
                || row.getString("object_key") != null
                || row.getString("object_version_id") != null
                || row.getString("encryption_key_id") != null
                || !("managed-" + domain).equals(row.getString("kind"))
                || row.getInt("schema_version") != 1
                || bytes.length != row.getLong("byte_length")
                || !sha256(bytes).equals(row.getString("sha256"))) {
            return null;
        }
        // Parsed as strictly as the store reads a committed body.
        JsonNode record = ManagedExtensionRecordStore.parse(new String(bytes,
                StandardCharsets.UTF_8));
        if (record == null) {
            return null;
        }
        try {
            if (domain.equals("hook_execution")) {
                ManagedHookRecords.requireExecution(record);
            } else {
                ManagedHookRecords.requireRegistration(record);
            }
            return ManagedHookRecords.admissionKeys(domain, record);
        } catch (InvalidRecordException error) {
            return null;
        }
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}
