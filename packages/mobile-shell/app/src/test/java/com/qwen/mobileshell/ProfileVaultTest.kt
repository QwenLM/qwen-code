package com.qwen.mobileshell

import java.io.IOException
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class ProfileVaultTest {
    private class Storage : VaultStorage {
        var saved: ByteArray? = null
        var fail = false
        override fun read() = saved?.clone()
        override fun write(bytes: ByteArray) {
            if (fail) throw IOException("Injected disk failure")
            saved = bytes.clone()
        }
    }

    private class Legacy : LegacyProfiles {
        var data: Pair<String?, String?> = null to null
        var fail = false
        var reads = 0
        override fun read(): Pair<String?, String?> { reads++; return data }
        override fun clear() {
            if (fail) throw IOException("Injected cleanup failure")
            data = null to null
        }
    }

    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val storage = Storage()
    private val legacy = Legacy()
    private val cipher = ProfileCipher { key }
    private val vault = ProfileVault(storage, cipher, legacy)

    @Test fun emptyInstallDoesNotCreateAVault() {
        assertTrue(vault.load().profiles.isEmpty())
        assertNull(storage.saved)
    }

    @Test fun migrationEncryptsBeforeRemovingPlaintextAndIsIdempotent() {
        legacy.data = "https://EXAMPLE.COM:443" to "synthetic-token"
        val first = vault.load()
        assertEquals("https://example.com/", first.profiles.single().origin)
        assertEquals("synthetic-token", first.profiles.single().token)
        assertEquals(null to null, legacy.data)
        assertFalse(String(storage.saved!!).contains("synthetic-token"))
        assertEquals(first, vault.load())
    }

    @Test fun failedMigrationWritePreservesLegacyData() {
        legacy.data = "https://example.com" to "test-token"
        storage.fail = true
        assertThrows(IOException::class.java) { vault.load() }
        assertEquals("test-token", legacy.data.second)
        assertNull(storage.saved)
        storage.fail = false
        assertEquals("test-token", vault.load().profiles.single().token)
    }

    @Test fun interruptedCleanupRetriesWithoutDuplicatingProfiles() {
        legacy.data = "https://example.com" to "test-token"
        legacy.fail = true
        assertThrows(IOException::class.java) { vault.load() }
        val committed = storage.saved!!.clone()
        assertEquals("test-token", legacy.data.second)
        legacy.fail = false
        assertEquals(1, vault.load().profiles.size)
        assertArrayEquals(committed, storage.saved)
        assertEquals(null to null, legacy.data)
    }

    @Test fun malformedLegacyAddressIsNotDiscarded() {
        legacy.data = "https://example.com/private" to "test-token"
        assertThrows(IllegalArgumentException::class.java) { vault.load() }
        assertEquals("test-token", legacy.data.second)
        assertNull(storage.saved)
    }

    @Test fun corruptVaultNeverFallsBackToLegacy() {
        val state = ProfileState(listOf(ConnectionProfile.create("A", "https://example.com", "a")))
        vault.save(state)
        legacy.data = "https://legacy.example" to "legacy"
        storage.saved!![20] = (storage.saved!![20].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { vault.load() }
        assertEquals(0, legacy.reads)
        assertEquals("legacy", legacy.data.second)
    }

    @Test fun missingKeyDoesNotGenerateAReplacementDuringRead() {
        vault.save(ProfileState())
        var createRequested = false
        val missing = ProfileVault(storage, ProfileCipher { create ->
            createRequested = create
            throw IOException("Missing key")
        }, legacy)
        assertThrows(IOException::class.java) { missing.load() }
        assertFalse(createRequested)
    }

    @Test fun renamePreservesIdentityButOriginAndCredentialChangesRotateBrowserState() {
        val original = ConnectionProfile.create("A", "https://example.com", "a")
        val rename = ConnectionProfile.create("Renamed", original.origin, "a", original)
        assertEquals(original.id, rename.id)
        assertEquals(original.browserId, rename.browserId)
        for (changed in listOf(
            ConnectionProfile.create("B", "https://other.example", "a", original),
            ConnectionProfile.create("B", original.origin, "b", original),
            ConnectionProfile.create("B", original.origin, null, original),
        )) {
            assertEquals(original.id, changed.id)
            assertNotEquals(original.browserId, changed.browserId)
            val next = vault.upsert(ProfileState(listOf(original)), changed)
            assertTrue(original.browserName in next.retiredBrowsers)
            assertEquals(next, vault.load())
        }
    }

    @Test fun deletePersistsRetiredBrowserAndDoesNotChangeOtherProfile() {
        val a = ConnectionProfile.create("A", "https://example.com", "a")
        val b = ConnectionProfile.create("B", "https://example.com", "b")
        val next = vault.remove(ProfileState(listOf(a, b)), a)
        assertEquals(listOf(b), next.profiles)
        assertTrue(a.browserName in next.retiredBrowsers)
        assertEquals(next, vault.load())
    }

    @Test fun writeFailureDoesNotChangeExistingVault() {
        vault.save(ProfileState())
        val saved = storage.saved!!.clone()
        storage.fail = true
        assertThrows(IOException::class.java) {
            vault.upsert(ProfileState(), ConnectionProfile.create("A", "https://example.com", "a"))
        }
        assertArrayEquals(saved, storage.saved)
    }

    @Test fun rejectsDuplicateProfileAndBrowserIdentitiesAndTrailingData() {
        val a = ConnectionProfile.create("A", "https://example.com", "a")
        for (bad in listOf(
            ProfileState(listOf(a, a)),
            ProfileState(listOf(a, a.copy(id = java.util.UUID.randomUUID().toString()))),
            ProfileState(listOf(a), setOf(a.browserName)),
        )) assertThrows(IOException::class.java) { ProfileVault.decode(ProfileVault.encode(bad)) }
        assertThrows(IOException::class.java) { ProfileVault.decode(ProfileVault.encode(ProfileState()) + byteArrayOf(0)) }
    }

    @Test fun normalizesDefaultPortsAndIpv6WithoutAcceptingUserinfoOrPaths() {
        assertEquals("https://example.com/", OriginPolicy.canonicalRoot("HTTPS://EXAMPLE.COM:443/"))
        assertEquals("http://[::1]:4170/", OriginPolicy.canonicalRoot("http://[::1]:4170"))
        for (bad in listOf("https://user@example.com", "https://example.com/path", "https://example.com/?token=x", "file:///tmp")) {
            assertNull(OriginPolicy.canonicalRoot(bad))
        }
        assertThrows(IllegalArgumentException::class.java) { ConnectionProfile.create(" ", "https://example.com", null) }
        assertThrows(IllegalArgumentException::class.java) { ConnectionProfile.create("A", "https://example.com", "token\n") }
        assertFalse(ConnectionProfile.create("A", "https://example.com", "secret").toString().contains("secret"))
    }
}
