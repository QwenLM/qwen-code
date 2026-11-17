package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.persistence.RuntimeAdmissionFences;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Pins persisted key digests to values computed outside Java (length-prefixed
 * SHA-256), so helper consolidation cannot silently change stored keys.
 */
class StorageKeyDigestCompatibilityTest {
    private static final String ALIAS =
            "ec77f5fe1b4225e8f8203d59b5858eb235f9155261c440efaa02efd5513bd2df";

    @Test
    void storageAliasKeyKeepsItsStoredBytes() {
        assertEquals(ALIAS, RuntimeAdmissionFences.storageAliasKey("tenant", "storage"));
    }

    @Test
    void valueKeysKeepTheirStoredBytes() {
        assertEquals("b35c2bbb8e03f30213215f7c88b5b91ee1cac80d659d74087947e5857ff3e3cf",
                RuntimeRequestKeys.valueKey("value"));
        assertEquals("ad95131bc0b799c0b1af477fb14fcf26a6a9f76079e48bf090acb7e8367bfd0e",
                RuntimeRequestKeys.valueKey(null));
    }
}