package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;

/**
 * Resolves CSI inventory journal record bytes, falling back to the published pack when the covered
 * SQL blob was deleted after packing. Split out of {@link WorkspaceCsiApplicationInventory} so that
 * class stays within its size ratchet.
 */
final class WorkspaceCsiJournalPackReader {
    private WorkspaceCsiJournalPackReader() {
    }

    /** Returns the inline record bytes, or the pack-resolved bytes, or null when neither exists. */
    static byte[] bytes(Row row, JdbcJournalPacks packs) {
        byte[] bytes = row.binary("record_bytes");
        if (bytes != null || packs == null) {
            return bytes;
        }
        try {
            return packs.resolveBytes(row.text("tenant_id"), row.text("session_id"),
                    row.number("journal_revision"), row.text("record_digest"),
                    row.number("byte_length"));
        } catch (RuntimeException unavailable) {
            return null;
        }
    }
}
