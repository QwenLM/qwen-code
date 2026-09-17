package com.qwen.mobileshell

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.webkit.WebView
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

internal class NativeDownloads(
    private val context: Context,
    private val launch: (Intent) -> Unit,
) {
    var awaitingResult = false
        private set
    private val handler = Handler(Looper.getMainLooper())
    private var pending: Request? = null
    private val timeout = Runnable { pending?.let { fail(it, "Download transfer timed out. Please retry.") } }

    private class Request(
        val buffer: DownloadBuffer,
        val name: String,
        val mime: String,
        val isCurrent: () -> Boolean,
        val reply: (String) -> Unit,
    ) {
        val cancelled = AtomicBoolean(false)
        var writing = false
    }

    fun restoreAwaitingResult(value: Boolean) { awaitingResult = value }

    fun install(view: WebView, origin: String, isCurrent: () -> Boolean): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) return false
        WebViewCompat.addWebMessageListener(view, BRIDGE_NAME, setOf(origin.removeSuffix("/"))) {
                source, message, sourceOrigin, mainFrame, reply ->
            if (source === view && mainFrame && isCurrent() &&
                OriginPolicy.isSameOrigin(origin, sourceOrigin.toString())) {
                receive(message, isCurrent) { reply.postMessage(it) }
            }
        }
        return true
    }

    internal fun receive(message: WebMessageCompat, isCurrent: () -> Boolean, reply: (String) -> Unit) {
        if (!isCurrent()) return
        if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            val request = pending ?: return
            if (request.cancelled.get() || awaitingResult || request.writing) return
            try {
                require(request.isCurrent()) { "The download connection changed." }
                request.buffer.append(message.arrayBuffer)
                respond(request, "chunk", request.buffer.offset)
                resetTimeout()
            } catch (error: IllegalArgumentException) { fail(request, error.message ?: "Invalid download data.") }
            return
        }
        val text = message.data ?: return
        if (text.length > 2048 || text.toByteArray(Charsets.UTF_8).size > 2048) return
        val command = try { JSONObject(text) } catch (_: Exception) { return }
        val id = command.optString("id")
        if (!id.matches(Regex("[a-f0-9]{32}"))) return
        fun reject(error: String) { reply(response(id, "error", error = error)) }
        if (command.opt("v") != 1) { reject("Unsupported download protocol."); return }
        when (command.optString("op")) {
            "begin" -> {
                if (pending != null || awaitingResult || writerBusy.get()) { reject("Another download is still active."); return }
                val size = command.opt("size") as? Number
                if (size == null || size.toDouble() !in 0.0..DownloadBuffer.MAX_SIZE.toDouble() || size.toDouble() != size.toInt().toDouble()) {
                    reject("Android downloads are limited to 16 MiB."); return
                }
                val name = command.opt("name") as? String
                val mime = command.opt("mime") as? String
                if (name == null || mime == null) { reject("Invalid download metadata."); return }
                val safeMime = mime.substringBefore(';').lowercase(Locale.ROOT).takeIf {
                    it.matches(Regex("[a-z0-9!#\u0024&^_.+-]+/[a-z0-9!#\u0024&^_.+-]+"))
                } ?: "application/octet-stream"
                val request = Request(DownloadBuffer(id, size.toInt()), DownloadBuffer.fileName(name), safeMime, isCurrent, reply)
                pending = request
                respond(request, "ready")
                resetTimeout()
            }
            "cancel" -> if (pending?.buffer?.id == id) cancel()
            "finish" -> {
                val request = pending
                if (request == null || request.buffer.id != id) { reject("No matching download."); return }
                if (awaitingResult || request.writing || request.cancelled.get()) { reject("Download is already being saved."); return }
                if (!request.isCurrent() || request.buffer.offset != request.buffer.bytes.size) { fail(request, "Download is incomplete or its connection changed."); return }
                handler.removeCallbacks(timeout)
                awaitingResult = true
                try {
                    launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = request.mime
                        putExtra(Intent.EXTRA_TITLE, request.name)
                        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                    })
                    respond(request, "choosing")
                } catch (_: RuntimeException) {
                    awaitingResult = false
                    fail(request, "The system Save picker is unavailable.")
                }
            }
            else -> reject("Unsupported download command.")
        }
    }

    fun cancel() {
        val request = pending ?: return
        if (!request.cancelled.get()) respond(request, "cancelled")
        request.cancelled.set(true)
        handler.removeCallbacks(timeout)
        if (!request.writing) {
            request.buffer.clear()
            pending = null
        }
        // A cancelled picker still owns its OS result; a writer still owns its memory slot.
    }

    fun result(code: Int, data: Intent?) {
        if (!awaitingResult) return
        awaitingResult = false
        val request = pending ?: return
        if (request.cancelled.get() || !request.isCurrent() || code != Activity.RESULT_OK) { cancel(); return }
        val uri = try { destination(data) } catch (_: RuntimeException) { null }
        if (uri == null) { fail(request, "The selected destination did not grant write access."); return }
        if (!writerBusy.compareAndSet(false, true)) { fail(request, "Another download is still being saved."); return }
        request.writing = true
        writer.execute {
            var error: String? = null
            try {
                check(!request.cancelled.get())
                context.contentResolver.openOutputStream(uri, "wt").use { output ->
                    checkNotNull(output)
                    val bytes = request.buffer.bytes
                    var offset = 0
                    while (offset < bytes.size) {
                        check(!request.cancelled.get())
                        val count = minOf(DownloadBuffer.CHUNK_SIZE, bytes.size - offset)
                        output.write(bytes, offset, count)
                        offset += count
                    }
                }
            } catch (_: Exception) { error = "Could not save the download. The destination may contain a partial file." }
            finally {
                request.buffer.clear()
                writerBusy.set(false)
            }
            handler.post {
                request.writing = false
                if (pending === request) {
                    if (!request.cancelled.get() && request.isCurrent()) {
                        respond(request, if (error == null) "saved" else "error", error = error)
                    }
                    pending = null
                }
            }
        }
    }

    private fun destination(data: Intent?): Uri? {
        if (data == null || data.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION == 0) return null
        val uri = data.data ?: return null
        if (uri.scheme != "content" || uri.authority.isNullOrBlank() || data.clipData != null) return null
        val provider = context.packageManager.resolveContentProvider(uri.authority!!, 0) ?: return null
        if (provider.applicationInfo.uid == context.applicationInfo.uid) return null
        if (context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return null
        return uri
    }

    private fun fail(request: Request, error: String) {
        respond(request, "error", error = error)
        request.cancelled.set(true)
        cancel()
    }

    private fun respond(request: Request, state: String, offset: Int? = null, error: String? = null) {
        if (request.isCurrent()) request.reply(response(request.buffer.id, state, offset, error))
    }

    private fun resetTimeout() {
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, 30_000)
    }

    companion object {
        const val BRIDGE_NAME = "qwenAndroidDownloadV1"
        private val writer = Executors.newSingleThreadExecutor()
        private val writerBusy = AtomicBoolean(false)
        private fun response(id: String, state: String, offset: Int? = null, error: String? = null): String =
            JSONObject().put("v", 1).put("id", id).put("state", state).apply {
                if (offset != null) put("offset", offset)
                if (error != null) put("error", error)
            }.toString()
    }
}
