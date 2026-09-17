package com.qwen.mobileshell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import android.widget.Toast
import java.util.Locale

internal class NativeFilePicker(
    private val context: Context,
    private val launch: (Intent) -> Unit,
) {
    var awaitingResult = false
        private set
    private var pending: Request? = null

    private class Request(
        val multiple: Boolean,
        val isCurrent: () -> Boolean,
        val callback: ValueCallback<Array<Uri>>,
    )

    fun restoreAwaitingResult(value: Boolean) { awaitingResult = value }

    fun open(params: FileChooserParams, isCurrent: () -> Boolean, callback: ValueCallback<Array<Uri>>): Boolean {
        if (awaitingResult || !isCurrent() || params.mode !in listOf(FileChooserParams.MODE_OPEN, FileChooserParams.MODE_OPEN_MULTIPLE)) {
            callback.onReceiveValue(null)
            return true
        }
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        val types = mimeTypes(params.acceptTypes.orEmpty())
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (types.size == 1) types.single() else "*/*"
            if (types.size > 1) putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        pending = Request(multiple, isCurrent, callback)
        awaitingResult = true
        try {
            launch(intent)
        } catch (_: ActivityNotFoundException) {
            launchFailed()
        } catch (_: SecurityException) {
            launchFailed()
        }
        return true
    }

    private fun launchFailed() {
        awaitingResult = false
        cancel()
        Toast.makeText(context, R.string.file_picker_unavailable, Toast.LENGTH_LONG).show()
    }

    fun cancel() {
        val request = pending
        pending = null
        // The OS result still belongs to this request, even after its callback is cancelled.
        request?.callback?.onReceiveValue(null)
    }

    fun result(code: Int, data: Intent?) {
        val request = pending
        pending = null
        awaitingResult = false
        if (request == null) return
        val uris = if (code == Activity.RESULT_OK && request.isCurrent()) {
            try { validateResult(data, request.multiple) } catch (_: RuntimeException) { null }
        } else null
        request.callback.onReceiveValue(uris)
    }

    private fun validateResult(data: Intent?, multiple: Boolean): Array<Uri>? {
        if (data == null || data.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION == 0) return null
        val clip = data.clipData
        if (clip != null && clip.itemCount > 100) return null
        val uris = buildList {
            data.data?.let(::add)
            if (clip != null) for (index in 0 until clip.itemCount) {
                add(clip.getItemAt(index).uri ?: return null)
            }
        }.distinct()
        if (uris.isEmpty() || uris.size > 100 || (!multiple && uris.size != 1)) return null
        for (uri in uris) {
            if (uri.scheme != "content" || uri.authority.isNullOrBlank()) return null
            val provider = context.packageManager.resolveContentProvider(uri.authority!!, 0) ?: return null
            if (provider.applicationInfo.uid == context.applicationInfo.uid) return null
            if (context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) return null
        }
        return uris.toTypedArray()
    }

    companion object {
        internal fun mimeTypes(accept: Array<out String>): List<String> {
            val hints = accept.flatMap { it.split(',') }.map { it.trim().lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }
            if (hints.isEmpty()) return listOf("*/*")
            val result = hints.map { hint ->
                val type = if (hint.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(hint.substringAfterLast('.')) else hint
                if (type == null || type == "*/*" || !type.matches(Regex("[a-z0-9!#\u0024&^_.+-]+/([a-z0-9!#\u0024&^_.+-]+|\\*)"))) return listOf("*/*")
                type
            }
            return result.distinct()
        }
    }
}
