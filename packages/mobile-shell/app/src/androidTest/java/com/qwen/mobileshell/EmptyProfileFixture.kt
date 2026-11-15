package com.qwen.mobileshell

import org.junit.Assume.assumeNoException
import org.junit.Assume.assumeTrue

internal class EmptyProfileFixture {
    private var originalBytes: ByteArray? = null
    private var needsRestore = false

    fun seed(
        vault: ProfileVault,
        profiles: List<ConnectionProfile>,
        hasLegacyData: Boolean,
        readBytes: () -> ByteArray?,
    ) {
        assumeTrue("Refusing to overwrite legacy connection data", !hasLegacyData)
        val bytes: ByteArray?
        val state: ProfileState
        try {
            bytes = readBytes()
            state = vault.load()
        } catch (error: Exception) {
            assumeNoException("Refusing to overwrite an unreadable connection vault", error)
            return
        }
        assumeTrue("Refusing to overwrite saved connections or retired browser data",
            state.profiles.isEmpty() && state.retiredBrowsers.isEmpty())
        originalBytes = bytes
        needsRestore = true
        vault.save(ProfileState(profiles))
    }

    fun restore(restoreBytes: (ByteArray?) -> Unit) {
        if (!needsRestore) return
        restoreBytes(originalBytes)
        needsRestore = false
    }
}
