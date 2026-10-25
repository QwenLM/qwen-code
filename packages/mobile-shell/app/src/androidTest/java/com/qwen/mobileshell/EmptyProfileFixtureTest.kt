package com.qwen.mobileshell

import java.io.IOException
import javax.crypto.spec.SecretKeySpec
import org.junit.AssumptionViolatedException
import org.junit.Assert.*
import org.junit.Test

class EmptyProfileFixtureTest {
    private class Storage : VaultStorage {
        var bytes: ByteArray? = null
        var writes = 0
        var failWrite = false
        override fun read() = bytes?.clone()
        override fun write(bytes: ByteArray) {
            writes++
            if (failWrite) throw IOException("Synthetic write failure")
            this.bytes = bytes.clone()
        }
    }

    private val storage = Storage()
    private val vault = ProfileVault(storage,
        ProfileCipher { SecretKeySpec(ByteArray(32) { 42 }, "AES") },
        object : LegacyProfiles {
            override fun read(): Pair<String?, String?> = null to null
            override fun clear() {}
        })
    private val fixture = EmptyProfileFixture()
    private val profile = ConnectionProfile.create("Synthetic", "https://synthetic.example", "synthetic-token")
    private var restores = 0

    private fun seed(hasLegacy: Boolean = false) = fixture.seed(vault, listOf(profile), hasLegacy, storage::read)
    private fun restore() = fixture.restore {
        restores++
        storage.bytes = it?.clone()
    }

    @Test fun populatedVaultIsSkippedWithoutAnyWriteOrCleanup() {
        vault.save(ProfileState(listOf(profile)))
        val saved = storage.read()
        storage.writes = 0
        try {
            assertThrows(AssumptionViolatedException::class.java) { seed() }
        } finally { restore() }
        assertArrayEquals(saved, storage.bytes)
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun retiredBrowserDataIsSkippedWithoutAnyWriteOrCleanup() {
        vault.save(ProfileState(retiredBrowsers = setOf(profile.browserName)))
        val saved = storage.read()
        storage.writes = 0
        try {
            assertThrows(AssumptionViolatedException::class.java) { seed() }
        } finally { restore() }
        assertArrayEquals(saved, storage.bytes)
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun unreadableVaultIsSkippedAndItsBytesArePreserved() {
        storage.bytes = byteArrayOf(1, 2, 3)
        try {
            assertThrows(AssumptionViolatedException::class.java) { seed() }
        } finally { restore() }
        assertArrayEquals(byteArrayOf(1, 2, 3), storage.bytes)
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun missingKeyIsSkippedAndCiphertextIsPreserved() {
        vault.save(ProfileState())
        val saved = storage.read()
        storage.writes = 0
        val unavailableKey = ProfileVault(storage, ProfileCipher { throw IOException("Synthetic missing key") },
            object : LegacyProfiles {
                override fun read(): Pair<String?, String?> = null to null
                override fun clear() {}
            })
        try {
            assertThrows(AssumptionViolatedException::class.java) {
                fixture.seed(unavailableKey, listOf(profile), false, storage::read)
            }
        } finally { restore() }
        assertArrayEquals(saved, storage.bytes)
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun legacyCredentialsAreSkippedBeforeAnyReadMigrationOrWrite() {
        val legacy = object : LegacyProfiles {
            override fun read(): Pair<String?, String?> = throw AssertionError("Legacy data must not be read or migrated")
            override fun clear() { throw AssertionError("Legacy data must not be removed") }
        }
        val legacyVault = ProfileVault(storage,
            ProfileCipher { throw AssertionError("Keystore must not be used") }, legacy)
        try {
            assertThrows(AssumptionViolatedException::class.java) {
                fixture.seed(legacyVault, listOf(profile), true) { throw AssertionError("Vault must not be read") }
            }
        } finally { restore() }
        assertNull(storage.bytes)
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun unreadableFileIsSkippedWithoutCleanup() {
        try {
            assertThrows(AssumptionViolatedException::class.java) {
                fixture.seed(vault, listOf(profile), false) { throw IOException("Synthetic read failure") }
            }
        } finally { restore() }
        assertEquals(0, storage.writes)
        assertEquals(0, restores)
    }

    @Test fun existingEmptyVaultIsRestoredByteForByteAfterCorruption() {
        vault.save(ProfileState())
        val saved = storage.read()
        try {
            seed()
            assertEquals(listOf(profile), vault.load().profiles)
            storage.bytes = byteArrayOf(1, 2, 3)
        } finally { restore() }
        assertArrayEquals(saved, storage.bytes)
        assertEquals(ProfileState(), vault.load())
        assertEquals(1, restores)
        restore()
        assertEquals(1, restores)
    }

    @Test fun initiallyAbsentVaultIsRemovedAfterSyntheticTest() {
        try {
            seed()
            assertEquals(listOf(profile), vault.load().profiles)
            storage.bytes = byteArrayOf(1, 2, 3)
        } finally { restore() }
        assertNull(storage.bytes)
        assertEquals(1, restores)
    }

    @Test fun failedSeedStillRestoresTheOriginalEmptyVault() {
        vault.save(ProfileState())
        val saved = storage.read()
        storage.failWrite = true
        try {
            assertThrows(IOException::class.java) { seed() }
        } finally { restore() }
        assertArrayEquals(saved, storage.bytes)
        assertEquals(1, restores)
    }

    @Test fun cleanupBeforeSetupDoesNothing() {
        storage.bytes = byteArrayOf(1, 2, 3)
        restore()
        assertArrayEquals(byteArrayOf(1, 2, 3), storage.bytes)
        assertEquals(0, restores)
    }
}
