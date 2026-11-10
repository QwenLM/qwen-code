package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import org.apache.commons.codec.digest.DigestUtils;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/** Each frame contains one original transaction; no JSON parsing or reserialization. */
final class JournalPackCodec {
    static final int MAX_BYTES = 64 * 1024 * 1024;
    static final int TARGET_BYTES = 32 * 1024 * 1024;
    static final int MAX_RECORDS = 4096;
    private static final int MAGIC = 0x514a5031;

    private JournalPackCodec() { }

    record Record(long revision, byte[] bytes, String digest) { }

    static byte[] encode(List<Record> records, Runnable guard) throws IOException {
        if (records.isEmpty() || records.size() > MAX_RECORDS) {
            throw new IOException("Invalid journal pack record count");
        }
        var bytes = new ByteArrayOutputStream();
        try (var gzip = new GZIPOutputStream(bytes); var output = new DataOutputStream(gzip)) {
            output.writeInt(MAGIC);
            output.writeInt(records.size());
            long previous = records.getFirst().revision() - 1;
            long total = 0;
            for (Record record : records) {
                guard.run();
                total += record.bytes().length;
                if (record.revision() != previous + 1 || record.bytes().length < 1
                        || record.bytes().length > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES || total > MAX_BYTES
                        || !DigestUtils.sha256Hex(record.bytes()).equals(record.digest())) {
                    throw new IOException("Invalid journal pack frame");
                }
                output.writeLong(record.revision());
                output.writeInt(record.bytes().length);
                output.write(HexFormat.of().parseHex(record.digest()));
                output.write(record.bytes());
                previous = record.revision();
            }
        }
        if (bytes.size() > MAX_BYTES) {
            throw new IOException("Compressed journal pack is too large");
        }
        return bytes.toByteArray();
    }

    static List<Record> decode(byte[] bytes, long first, long last, Runnable guard) throws IOException {
        if (bytes.length > MAX_BYTES || first < 1 || last < first || last - first >= MAX_RECORDS) {
            throw new IOException("Invalid journal pack range");
        }
        try (var input = new DataInputStream(new GZIPInputStream(new ByteArrayInputStream(bytes)))) {
            if (input.readInt() != MAGIC || input.readInt() != last - first + 1) {
                throw new IOException("Unsupported journal pack format");
            }
            var records = new ArrayList<Record>();
            long total = 0;
            for (long revision = first; revision <= last; revision++) {
                guard.run();
                long actual = input.readLong();
                int length = input.readInt();
                total += length;
                if (actual != revision || length < 1 || length > ManagedSessionStoreModels.MAX_TRANSACTION_BYTES || total > MAX_BYTES) {
                    throw new IOException("Invalid journal pack frame");
                }
                byte[] digest = input.readNBytes(32);
                byte[] record = input.readNBytes(length);
                if (digest.length != 32 || record.length != length || !Arrays.equals(DigestUtils.sha256(record), digest)) {
                    throw new IOException("Journal pack frame integrity mismatch");
                }
                records.add(new Record(revision, record, HexFormat.of().formatHex(digest)));
            }
            if (input.read() != -1) {
                throw new IOException("Trailing journal pack data");
            }
            return List.copyOf(records);
        }
    }
}
