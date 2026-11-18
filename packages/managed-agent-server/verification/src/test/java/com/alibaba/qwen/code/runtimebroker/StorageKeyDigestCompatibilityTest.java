package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedCsiProtocol;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Pins persisted key digests to values computed outside Java (length-prefixed
 * SHA-256), so helper consolidation cannot silently change stored keys.
 */
class StorageKeyDigestCompatibilityTest {
    private static final String ALIAS =
            "ec77f5fe1b4225e8f8203d59b5858eb235f9155261c440efaa02efd5513bd2df";

    @Test
    void storageAliasKeyMatchesTheSharedRegistrationKey() {
        assertEquals(ALIAS, WorkspaceCsiRegistration.aliasKey("tenant", "storage"));
        assertEquals(ALIAS, JdbcRuntimeBindingRepository.storageAliasKey("tenant", "storage"));
    }

    @Test
    void physicalAndValueKeysKeepTheirStoredBytes() {
        assertEquals("67cbc58e709784c1a3e94111d37ea41df4bef458a9b52a25e4a997efd5b357fd",
                ManagedCsiProtocol.physicalKey("backend", "driver", "handle"));
        assertEquals("b35c2bbb8e03f30213215f7c88b5b91ee1cac80d659d74087947e5857ff3e3cf",
                RuntimeRequestKeys.valueKey("value"));
        assertEquals("ad95131bc0b799c0b1af477fb14fcf26a6a9f76079e48bf090acb7e8367bfd0e",
                RuntimeRequestKeys.valueKey(null));
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                CsiNativeActivationProof.sha256("abc".getBytes(StandardCharsets.UTF_8)));
    }
}
