package com.qwen.mobileshell

import android.webkit.PermissionRequest
import java.net.URI
import java.net.URISyntaxException

internal class NativeMicrophonePermission(
    private val hasPermission: () -> Boolean,
    private val launchPermission: () -> Unit,
    private val onGranted: () -> Unit,
) {
    var awaitingResult = false
        private set
    private var pending: Request? = null

    private class Request(val web: PermissionRequest, val isCurrent: () -> Boolean)

    fun restoreAwaitingResult(value: Boolean) { awaitingResult = value }

    fun begin(web: PermissionRequest, origin: String, isCurrent: () -> Boolean): Boolean {
        // Use the same strict parser as OriginPolicy; legacy Android Uri misparses IPv6 hosts.
        val uri = try { URI(origin) } catch (_: URISyntaxException) {
            web.deny()
            return false
        }
        val secure = uri.scheme == "https" || (uri.scheme == "http" && uri.host in listOf("localhost", "127.0.0.1", "[::1]", "::1"))
        if (pending != null || awaitingResult || !secure || !isCurrent() ||
            !OriginPolicy.isSameOrigin(origin, web.origin.toString()) ||
            !web.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))) {
            web.deny()
            return false
        }
        pending = Request(web, isCurrent)
        return true
    }

    fun decide(web: PermissionRequest, allowed: Boolean) {
        val request = pending?.takeIf { it.web === web } ?: return
        if (!allowed || !request.isCurrent()) { finish(false); return }
        if (hasPermission()) { finish(true); return }
        if (awaitingResult) return
        awaitingResult = true
        try { launchPermission() }
        catch (_: SecurityException) {
            awaitingResult = false
            finish(false)
        }
    }

    fun result(granted: Boolean) {
        if (!awaitingResult) return
        awaitingResult = false
        finish(granted)
    }

    fun cancel() { finish(false) }

    fun cancelledByWebView(web: PermissionRequest): Boolean {
        if (pending?.web !== web) return false
        pending = null
        return true
    }

    private fun finish(allowed: Boolean) {
        val request = pending ?: return
        pending = null
        // A late Android result retains its slot after cancellation; it cannot grant a new page.
        if (allowed && request.isCurrent() && hasPermission()) {
            onGranted()
            request.web.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        } else request.web.deny()
    }
}
