package com.qwen.mobileshell

import java.util.UUID

internal data class ConnectionProfile(
    val id: String,
    val name: String,
    val origin: String,
    val token: String?,
    val browserId: String,
    val browserInitialized: Boolean = false,
) {
    companion object {
        fun create(name: String, origin: String, token: String?, previous: ConnectionProfile? = null): ConnectionProfile {
            val label = name.trim()
            require(label.isNotEmpty() && label.length <= 120) { "Enter a name of at most 120 characters." }
            val root = OriginPolicy.canonicalRoot(origin.trim())
                ?: throw IllegalArgumentException("Enter an HTTP(S) origin without a path, query or fragment.")
            require(root.length <= 2048) { "The daemon address is too long." }
            val credential = token?.takeIf { it.isNotEmpty() }
            require(credential == null || (credential.length <= 8192 && credential.none { it.isISOControl() })) {
                "The credential is invalid or too long."
            }
            val sameConnection = previous?.origin == root && previous.token == credential
            return ConnectionProfile(
                previous?.id ?: UUID.randomUUID().toString(), label, root, credential,
                if (sameConnection) previous!!.browserId else UUID.randomUUID().toString(),
                sameConnection && previous!!.browserInitialized,
            )
        }
    }

    val browserName: String get() = "qwen-$browserId"

    fun needsBrowserInitialization(knownNames: Collection<String>): Boolean =
        !browserInitialized || browserName !in knownNames

    override fun toString(): String = "ConnectionProfile(id=$id)"
}
