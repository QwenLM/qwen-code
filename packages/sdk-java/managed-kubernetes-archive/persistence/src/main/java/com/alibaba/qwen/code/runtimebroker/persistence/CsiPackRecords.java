package com.alibaba.qwen.code.runtimebroker.persistence;

import com.alibaba.qwen.code.managedagent.persistence.JdbcJournalPacks;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;

import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * Resolves a CSI journal row's {@code record_bytes}, falling back to the published journal pack
 * once compaction has evicted the SQL blob. The inline {@code record_digest} and {@code byte_length}
 * survive eviction, so the resolved bytes are always re-verified against them. Returns null when the
 * bytes are absent and no pack can supply them (no bundle, or a bundle without a configured object
 * store), or when they fail verification: callers stay fail-closed by requiring a non-null result
 * with their own admission exception.
 */
final class CsiPackRecords {
    private CsiPackRecords() {
    }

    static byte[] resolve(ResultSet row, JdbcJournalPacks packs, String tenant, String session,
            long revision) throws SQLException {
        byte[] bytes = row.getBytes("record_bytes");
        if (bytes == null) {
            // A storeless bundle cannot supply evicted bytes; return null instead of letting
            // resolveBytes' store() throw 501, so the caller raises its own admission exception.
            if (packs == null || !packs.hasObjectStore()) {
                return null;
            }
            bytes = packs.resolveBytes(tenant, session, revision, row.getString("record_digest"),
                    row.getLong("byte_length"));
        }
        if (bytes == null || bytes.length != row.getLong("byte_length")
                || !CsiNativeActivationProof.sha256(bytes).equals(row.getString("record_digest"))) {
            return null;
        }
        return bytes;
    }
}
