package com.qwen.mobileshell

import android.os.Bundle

/** Contains neither credentials nor an origin; both must come from a fresh vault read. */
internal data class ConnectionRecovery(
    val profileId: String,
    val browserId: String,
    val navigation: ConnectionNavigation = ConnectionNavigation(),
    val retryRequired: Boolean = false,
) {
    fun findProfile(state: ProfileState): ConnectionProfile? =
        state.profiles.find { it.id == profileId && it.browserId == browserId }

    fun toBundle(): Bundle = Bundle().apply {
        putString("profile", profileId)
        putString("browser", browserId)
        putString("session", navigation.session)
        putString("workspace", navigation.workspace)
        putString("context", navigation.context)
        putBoolean("retry", retryRequired)
    }

    companion object {
        private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

        fun fromBundle(bundle: Bundle?): ConnectionRecovery? {
            if (bundle == null) return null
            val profileId = bundle.getString("profile")?.takeIf { uuid.matches(it) } ?: return null
            val browserId = bundle.getString("browser")?.takeIf { uuid.matches(it) } ?: return null
            val navigation = ConnectionNavigation.fromFields(bundle.getString("session"), bundle.getString("workspace"), bundle.getString("context")) ?: return null
            return ConnectionRecovery(profileId, browserId, navigation, bundle.getBoolean("retry"))
        }
    }
}
