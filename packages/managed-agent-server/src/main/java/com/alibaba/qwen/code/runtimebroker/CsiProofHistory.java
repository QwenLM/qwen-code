package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.core.json.JsonWriteFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.slf4j.LoggerFactory;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.AbstractMap;
import java.util.AbstractSet;
import java.util.Arrays;
import java.util.Iterator;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;

/** Request-private CSI proof facts. Canonical history and SQL remain the authority. */
public final class CsiProofHistory implements AutoCloseable {
    private static final ObjectMapper CODEC = codec();
    private static final int BUCKETS = 1 << 14;
    // The 8 MiB message can expand 3x when doubles are written, plus bounded batch metadata.
    private static final int MAX_VALUE_BYTES = 32 * 1024 * 1024;
    private static final int HEADER_BYTES = 2 * Long.BYTES + 2 * Integer.BYTES;
    private final long[] heads = new long[BUCKETS];
    private final byte[] hashes = new byte[BUCKETS * 32];
    private final long[] versions = new long[8];
    private final Path path;
    private final RandomAccessFile file;
    private long length;
    private boolean closed;

    private static ObjectMapper codec() {
        ObjectMapper codec = CsiNativeActivationProof.JSON.copy()
                .enable(JsonReadFeature.ALLOW_NON_NUMERIC_NUMBERS.mappedFeature())
                .disable(JsonWriteFeature.WRITE_NAN_AS_STRINGS.mappedFeature());
        // A receipt wraps its verified resource body; the other fixed DTOs need fewer layers.
        codec.getFactory().setStreamReadConstraints(codec.getFactory().streamReadConstraints().rebuild()
                .maxNestingDepth(72).build());
        return codec;
    }

    private CsiProofHistory() throws IOException {
        path = Files.createTempFile("qwen-csi-proof-", ".scratch");
        RandomAccessFile opened;
        try {
            opened = new RandomAccessFile(path.toFile(), "rw");
        } catch (IOException error) {
            Files.deleteIfExists(path);
            throw error;
        }
        file = opened;
    }

    private static final ThreadLocal<Scope> CURRENT = new ThreadLocal<>();

    static final class Scope implements AutoCloseable {
        private final Scope previous = CURRENT.get();
        private CsiProofHistory owners;

        private Scope() {
            CURRENT.set(this);
        }

        @Override
        public void close() {
            CURRENT.set(previous);
            while (owners != null) {
                var owner = owners;
                owners = owner.nextOwner;
                owner.nextOwner = null;
                owner.close();
            }
            if (previous == null) {
                CURRENT.remove();
            }
        }
    }

    private CsiProofHistory nextOwner;

    static Scope scope() {
        return new Scope();
    }

    public static CsiProofHistory temporary() {
        try {
            return new CsiProofHistory();
        } catch (IOException error) {
            throw failure(error);
        }
    }

    static CsiProofHistory create() {
        try {
            var history = new CsiProofHistory();
            if (TransactionSynchronizationManager.isSynchronizationActive()) {
                TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                    @Override
                    public void afterCompletion(int status) {
                        history.close();
                    }
                });
            } else if (CURRENT.get() != null) {
                history.nextOwner = CURRENT.get().owners;
                CURRENT.get().owners = history;
            }
            return history;
        } catch (IOException error) {
            throw failure(error);
        }
    }

    public <T> Map<String, T> map(int family, Class<T> type) {
        return new Facts<>(this, family, type, 0, 0, true);
    }

    public Set<String> identities(int family) {
        return new Identities(new Facts<>(this, family, Boolean.class, 0, 0, true));
    }

    Set<String> identities() {
        return new Identities(new Facts<>(this, 0, Boolean.class, 0, 0, true));
    }

    @SuppressWarnings("unchecked")
    static <T> Map<String, T> freeze(Map<String, T> map) {
        return map instanceof Facts<?> facts ? ((Facts<T>) facts).copy(false) : Map.copyOf(map);
    }

    @SuppressWarnings("unchecked")
    static <T> Map<String, T> mutable(Map<String, T> map) {
        return map instanceof Facts<?> facts ? ((Facts<T>) facts).copy(true) : new java.util.HashMap<>(map);
    }

    static Set<String> freeze(Set<String> set) {
        return set instanceof Identities identities ? new Identities(identities.facts.copy(false)) : Set.copyOf(set);
    }

    static Set<String> mutable(Set<String> set) {
        return set instanceof Identities identities ? new Identities(identities.facts.copy(true)) : new java.util.HashSet<>(set);
    }

    static boolean spilled(Map<?, ?> map) {
        return map instanceof Facts<?>;
    }

    static Map<String, CsiNativeActivationProof.FrozenBatch> frozenBatches(Set<String> identities) {
        return identities instanceof Identities values ? values.facts.owner.map(4, CsiNativeActivationProof.FrozenBatch.class)
                : new java.util.HashMap<>();
    }

    static void close(Set<String> set) {
        if (set instanceof Identities identities) {
            identities.facts.owner.close();
        }
    }

    private record Record(long offset, long previous, long firstVersion, String key, byte[] value, long end,
            byte[] previousHash, byte[] hash) {
    }

    private Record read(long offset, byte[] expected) throws IOException {
        require(!closed && offset >= 0 && offset < length && file.length() == length);
        file.seek(offset);
        byte[] header = new byte[HEADER_BYTES];
        file.readFully(header);
        ByteBuffer fields = ByteBuffer.wrap(header);
        long previous = fields.getLong();
        long first = fields.getLong();
        int keySize = fields.getInt();
        int valueSize = fields.getInt();
        require(previous >= 0 && previous <= offset && first >= 0 && first <= offset
                && keySize > 0 && keySize <= 2048 && valueSize > 0 && valueSize <= MAX_VALUE_BYTES
                && offset + HEADER_BYTES + keySize + valueSize + 64L <= length);
        byte[] key = new byte[keySize];
        byte[] value = new byte[valueSize];
        byte[] previousHash = new byte[32];
        byte[] hash = new byte[32];
        file.readFully(key);
        file.readFully(value);
        file.readFully(previousHash);
        file.readFully(hash);
        var checksum = DigestUtils.getSha256Digest();
        checksum.update(header);
        checksum.update(key);
        checksum.update(value);
        checksum.update(previousHash);
        require(MessageDigest.isEqual(hash, checksum.digest())
                && (expected == null || MessageDigest.isEqual(expected, hash)));
        String identity = new String(key, StandardCharsets.UTF_8);
        require(Arrays.equals(key, identity.getBytes(StandardCharsets.UTF_8)));
        return new Record(offset, previous, first, identity, value,
                offset + HEADER_BYTES + keySize + valueSize + 64L, previousHash, hash);
    }

    private Record find(String key, long through) {
        require(!closed && through >= 0 && through <= length);
        try {
            require(file.length() == length);
        } catch (IOException error) {
            throw failure(error);
        }
        int bucket = bucket(key);
        long next = heads[bucket];
        byte[] expected = Arrays.copyOfRange(hashes, bucket * 32, bucket * 32 + 32);
        try {
            while (next > 0) {
                Record record = read(next - 1, expected);
                if (record.end() <= through && record.key().equals(key)) {
                    return record;
                }
                next = record.previous();
                expected = record.previousHash();
            }
            // A negative is anchored in the in-memory head's complete digest chain.
            require(MessageDigest.isEqual(expected, new byte[32]));
            return null;
        } catch (IOException error) {
            throw failure(error);
        }
    }

    private Record append(String key, byte[] value, long first) {
        require(!closed && value.length > 0 && value.length <= MAX_VALUE_BYTES);
        byte[] identity = key.getBytes(StandardCharsets.UTF_8);
        require(identity.length > 0 && identity.length <= 2048);
        int bucket = bucket(key);
        long offset = length;
        long previous = heads[bucket];
        byte[] header = ByteBuffer.allocate(HEADER_BYTES).putLong(previous).putLong(first)
                .putInt(identity.length).putInt(value.length).array();
        byte[] previousHash = Arrays.copyOfRange(hashes, bucket * 32, bucket * 32 + 32);
        var checksum = DigestUtils.getSha256Digest();
        checksum.update(header);
        checksum.update(identity);
        checksum.update(value);
        checksum.update(previousHash);
        byte[] hash = checksum.digest();
        try {
            require(file.length() == length);
            file.seek(offset);
            file.write(header);
            file.write(identity);
            file.write(value);
            file.write(previousHash);
            file.write(hash);
            length += HEADER_BYTES + identity.length + value.length + 64L;
            heads[bucket] = offset + 1;
            System.arraycopy(hash, 0, hashes, bucket * 32, hash.length);
            return new Record(offset, previous, first, key, value, length, previousHash, hash);
        } catch (IOException error) {
            throw failure(error);
        }
    }

    private static int bucket(String key) {
        byte[] digest = DigestUtils.sha256(key.getBytes(StandardCharsets.UTF_8));
        return ((Byte.toUnsignedInt(digest[0]) << 8) | Byte.toUnsignedInt(digest[1])) & (BUCKETS - 1);
    }

    private static final class Facts<T> extends AbstractMap<String, T> {
        private final CsiProofHistory owner;
        private final int family;
        private final Class<T> type;
        private final boolean mutable;
        private long through;
        private int count;

        private Facts(CsiProofHistory owner, int family, Class<T> type, long through, int count, boolean mutable) {
            require(family >= 0 && family < owner.versions.length);
            this.owner = owner;
            this.family = family;
            this.type = type;
            this.through = through;
            this.count = count;
            this.mutable = mutable;
        }

        private Facts<T> copy(boolean writable) {
            return new Facts<>(owner, family, type, through, count, writable);
        }

        private String key(String key) {
            return family + ":" + key;
        }

        private T decode(Record record) {
            if (record == null) {
                return null;
            }
            try {
                return CODEC.readValue(record.value(), type);
            } catch (IOException error) {
                throw failure(error);
            }
        }

        @Override
        public T get(Object key) {
            return key instanceof String value ? decode(owner.find(key(value), through)) : null;
        }

        @Override
        public boolean containsKey(Object key) {
            return key instanceof String value && owner.find(key(value), through) != null;
        }

        @Override
        public T put(String key, T value) {
            require(mutable && value != null && owner.versions[family] == through);
            Record previous = owner.find(key(key), through);
            try {
                Record stored = owner.append(key(key), CODEC.writeValueAsBytes(value),
                        previous == null ? 0 : previous.firstVersion() == 0 ? previous.offset() + 1 : previous.firstVersion());
                through = stored.end();
                owner.versions[family] = through;
                if (previous == null) {
                    count++;
                }
                return decode(previous);
            } catch (IOException error) {
                throw failure(error);
            }
        }

        @Override
        public int size() {
            require(!owner.closed);
            return count;
        }

        @Override
        public Set<Entry<String, T>> entrySet() {
            return new AbstractSet<>() {
                @Override
                public int size() {
                    return Facts.this.size();
                }

                @Override
                public Iterator<Entry<String, T>> iterator() {
                    return new Iterator<>() {
                        private long offset;
                        private int seen;
                        private Entry<String, T> pending;

                        @Override
                        public boolean hasNext() {
                            require(!owner.closed);
                            if (pending != null) {
                                return true;
                            }
                            try {
                                while (offset < through) {
                                    Record record = owner.read(offset, null);
                                    offset = record.end();
                                    require(offset <= through);
                                    if (record.key().startsWith(family + ":") && record.firstVersion() == 0) {
                                        Record latest = owner.find(record.key(), through);
                                        require(latest != null && (latest.firstVersion() == record.offset() + 1
                                                || latest.offset() == record.offset()));
                                        pending = new SimpleImmutableEntry<>(record.key().substring(2), decode(latest));
                                        seen++;
                                        return true;
                                    }
                                }
                                require(offset == through && seen == count);
                                return false;
                            } catch (IOException error) {
                                throw failure(error);
                            }
                        }

                        @Override
                        public Entry<String, T> next() {
                            if (!hasNext()) {
                                throw new NoSuchElementException();
                            }
                            Entry<String, T> result = pending;
                            pending = null;
                            return result;
                        }
                    };
                }
            };
        }
    }

    private static final class Identities extends AbstractSet<String> {
        private final Facts<Boolean> facts;

        private Identities(Facts<Boolean> facts) {
            this.facts = facts;
        }

        @Override
        public boolean add(String value) {
            if (facts.containsKey(value)) {
                return false;
            }
            facts.put(value, true);
            return true;
        }

        @Override
        public boolean contains(Object value) {
            return facts.containsKey(value);
        }

        @Override
        public int size() {
            return facts.size();
        }

        @Override
        public Iterator<String> iterator() {
            return facts.keySet().iterator();
        }
    }

    @Override
    public void close() {
        if (closed) {
            return;
        }
        closed = true;
        try {
            try {
                file.close();
            } finally {
                Files.deleteIfExists(path);
            }
        } catch (IOException error) {
            LoggerFactory.getLogger(CsiProofHistory.class).warn("Could not close private CSI proof scratch", error);
        }
    }

    private static IllegalArgumentException failure(IOException error) {
        return new IllegalArgumentException("CSI proof scratch is unavailable", error);
    }

    private static void require(boolean condition) {
        if (!condition) {
            throw new IllegalArgumentException("Invalid CSI proof scratch");
        }
    }
}
