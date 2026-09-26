package com.qwen.mobileshell

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.ParcelFileDescriptor
import java.io.File

// This provider runs in the test APK's process, outside the instrumented app's UID.
class FilePickerFixtureProvider : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle {
        val owner = requireNotNull(context)
        check(Binder.getCallingUid() == owner.packageManager.getApplicationInfo(TARGET, 0).uid)
        val identity = Binder.clearCallingIdentity()
        try {
            when (method) {
                "grant" -> owner.grantUriPermission(TARGET, uri(requireNotNull(arg).toInt()), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                "reset" -> (0..100).forEach {
                    owner.revokeUriPermission(TARGET, uri(it), Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    val file = File(owner.cacheDir, "picker-fixture-$it.txt")
                    check(!file.exists() || file.delete())
                }
                else -> error("Unknown fixture operation")
            }
        } finally {
            Binder.restoreCallingIdentity(identity)
        }
        return Bundle.EMPTY
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        require(mode == "r")
        val index = requireNotNull(uri.lastPathSegment).toInt()
        require(uri == FilePickerFixtureProvider.uri(index))
        val file = File(requireNotNull(context).cacheDir, "picker-fixture-$index.txt")
        file.writeBytes(contents(index))
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getType(uri: Uri) = "text/plain"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException()
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException()

    companion object {
        private const val TARGET = "com.qwen.mobileshell"
        val BASE_URI: Uri = Uri.parse("content://com.qwen.mobileshell.test.picker")
        fun uri(index: Int): Uri {
            require(index in 0..100)
            return BASE_URI.buildUpon().appendPath(index.toString()).build()
        }
        fun contents(index: Int) = "Synthetic picker document $index\n".toByteArray(Charsets.UTF_8)
    }
}
