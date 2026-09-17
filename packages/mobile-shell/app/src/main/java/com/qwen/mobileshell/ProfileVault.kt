package com.qwen.mobileshell

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.util.UUID

internal data class ProfileState(
    val profiles: List<ConnectionProfile> = emptyList(),
    val retiredBrowsers: Set<String> = emptySet(),
)

internal interface VaultStorage {
    fun read(): ByteArray?
    fun write(bytes: ByteArray)
}

internal interface VaultCipher {
    fun encrypt(bytes: ByteArray): ByteArray
    fun decrypt(bytes: ByteArray): ByteArray
}

internal interface LegacyProfiles {
    fun read(): Pair<String?, String?>
    fun clear()
}

internal class ProfileVault(
    private val storage: VaultStorage,
    private val cipher: VaultCipher,
    private val legacy: LegacyProfiles,
) {
    fun load(): ProfileState {
        val saved = storage.read()
        if (saved != null) {
            val state = decode(cipher.decrypt(saved))
            legacy.clear()
            return state
        }
        val (origin, token) = legacy.read()
        if (origin == null && token == null) return ProfileState()
        val profile = ConnectionProfile.create("Development", origin.orEmpty(), token)
        val state = ProfileState(listOf(profile))
        save(state)
        legacy.clear()
        return state
    }

    fun save(state: ProfileState) {
        require(state.profiles.size <= 64 && state.retiredBrowsers.size <= 4096) { "Restart the app to clean up retired connection data." }
        val plain = encode(state)
        try {
            if (plain.size > 2 * 1024 * 1024 - 29) throw IOException("Saved connection data is too large.")
            val encrypted = cipher.encrypt(plain)
            val verified = cipher.decrypt(encrypted)
            try {
                check(plain.contentEquals(verified)) { "Credential storage verification failed." }
            } finally {
                verified.fill(0)
            }
            storage.write(encrypted)
        } finally {
            plain.fill(0)
        }
    }

    fun upsert(state: ProfileState, profile: ConnectionProfile): ProfileState {
        val previous = state.profiles.find { it.id == profile.id }
        require(previous != null || state.profiles.size < 64) { "At most 64 profiles are supported." }
        val retired = if (previous != null && previous.browserId != profile.browserId) {
            state.retiredBrowsers + previous.browserName
        } else state.retiredBrowsers
        val next = ProfileState(
            if (previous == null) state.profiles + profile else state.profiles.map { if (it.id == profile.id) profile else it },
            retired,
        )
        save(next)
        return next
    }

    fun remove(state: ProfileState, profile: ConnectionProfile): ProfileState {
        val next = ProfileState(state.profiles.filterNot { it.id == profile.id }, state.retiredBrowsers + profile.browserName)
        save(next)
        return next
    }

    companion object {
        private const val MAGIC = 0x51575032

        internal fun encode(state: ProfileState): ByteArray = ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.writeInt(MAGIC)
                output.writeInt(state.profiles.size)
                for (profile in state.profiles) {
                    output.writeUTF(profile.id)
                    output.writeUTF(profile.name)
                    output.writeUTF(profile.origin)
                    output.writeUTF(profile.token.orEmpty())
                    output.writeUTF(profile.browserId)
                }
                output.writeInt(state.retiredBrowsers.size)
                state.retiredBrowsers.forEach(output::writeUTF)
            }
            bytes.toByteArray()
        }

        internal fun decode(bytes: ByteArray): ProfileState = try {
            DataInputStream(ByteArrayInputStream(bytes)).use { input ->
                require(input.readInt() == MAGIC)
                val count = input.readInt().also { require(it in 0..64) }
                val profiles = List(count) {
                    val id = input.readUTF().also { require(UUID.fromString(it).toString() == it) }
                    val name = input.readUTF()
                    val origin = input.readUTF()
                    val token = input.readUTF().ifEmpty { null }
                    val browserId = input.readUTF().also { require(UUID.fromString(it).toString() == it) }
                    val validated = ConnectionProfile.create(name, origin, token)
                    require(validated.name == name && validated.origin == origin)
                    ConnectionProfile(id, name, origin, token, browserId)
                }
                require(profiles.map { it.id }.toSet().size == profiles.size)
                require(profiles.map { it.browserId }.toSet().size == profiles.size)
                val retiredCount = input.readInt().also { require(it in 0..4096) }
                val retired = List(retiredCount) {
                    input.readUTF().also { name ->
                        require(name.startsWith("qwen-") && UUID.fromString(name.removePrefix("qwen-")).toString() == name.removePrefix("qwen-"))
                    }
                }.toSet()
                require(profiles.none { it.browserName in retired })
                require(input.read() == -1)
                ProfileState(profiles, retired)
            }
        } catch (error: Exception) {
            throw IOException("Saved connection data is invalid.", error)
        } finally {
            bytes.fill(0)
        }
    }
}
