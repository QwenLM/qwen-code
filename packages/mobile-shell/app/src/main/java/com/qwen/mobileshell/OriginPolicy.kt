package com.qwen.mobileshell

import java.net.URI
import java.net.URISyntaxException

internal object OriginPolicy {
    private fun parseHttp(value: String): URI? = try {
        URI(value).takeIf {
            (it.scheme.equals("https", true) || it.scheme.equals("http", true)) &&
                !it.host.isNullOrBlank() && it.rawUserInfo == null &&
                (it.port == -1 || it.port in 1..65535)
        }
    } catch (_: URISyntaxException) {
        null
    }

    fun isDaemonRoot(value: String): Boolean = parseHttp(value)?.let {
        (it.rawPath.isNullOrEmpty() || it.rawPath == "/") &&
            it.rawQuery == null && it.rawFragment == null
    } ?: false

    fun isSameOrigin(origin: String, target: String): Boolean {
        val left = parseHttp(origin) ?: return false
        val right = parseHttp(target) ?: return false
        fun port(uri: URI) = if (uri.port != -1) uri.port else if (uri.scheme.equals("https", true)) 443 else 80
        return left.scheme.equals(right.scheme, true) && left.host.equals(right.host, true) && port(left) == port(right)
    }

    fun isExternalLink(value: String): Boolean = parseHttp(value) != null || try {
        URI(value).scheme.equals("mailto", true)
    } catch (_: URISyntaxException) {
        false
    }
}
