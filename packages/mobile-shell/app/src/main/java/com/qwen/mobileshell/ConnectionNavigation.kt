package com.qwen.mobileshell

import java.net.URI

/** Deliberately narrower than an arbitrary WebView URL or saved browsing history. */
internal data class ConnectionNavigation(
    val session: String? = null,
    val workspace: String? = null,
    val context: String? = null,
) {
    fun url(origin: String): String {
        val path = session?.let { "session/$it" }.orEmpty()
        val query = listOfNotNull(workspace?.let { "workspace=$it" }, context?.let { "context=$it" }).joinToString("&")
        return origin + path + if (query.isEmpty()) "" else "?$query"
    }

    companion object {
        private val identifier = Regex("[A-Za-z0-9_-]{1,128}")

        fun fromFields(session: String?, workspace: String?, context: String?): ConnectionNavigation? {
            if (session != null && !identifier.matches(session)) return null
            if (workspace != null && !identifier.matches(workspace)) return null
            if (context != null && context !in listOf("standalone", "live")) return null
            return ConnectionNavigation(session, workspace, context)
        }

        fun capture(origin: String, url: String?): ConnectionNavigation {
            val root = ConnectionNavigation()
            if (url == null || url.length > 8192 || !OriginPolicy.isSameOrigin(origin, url)) return root
            val uri = URI(url) // isSameOrigin has already checked URI syntax and user information.
            val path = uri.rawPath.orEmpty()
            val session = when {
                path.isEmpty() || path == "/" -> null
                path.startsWith("/session/") -> path.removePrefix("/session/")
                else -> return root
            }
            val query = mutableMapOf<String, String>()
            if (uri.rawQuery != null) {
                for (part in uri.rawQuery.split('&')) {
                    val pair = part.split('=', limit = 2)
                    if (pair.size != 2 || pair[0] !in listOf("workspace", "context") || query.containsKey(pair[0])) return root
                    query[pair[0]] = pair[1]
                }
            }
            return fromFields(session, query["workspace"], query["context"]) ?: root
        }
    }
}
