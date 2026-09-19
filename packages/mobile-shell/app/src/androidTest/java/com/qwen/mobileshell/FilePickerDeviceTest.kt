package com.qwen.mobileshell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FilePickerDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    private class Params(private val selectionMode: Int = MODE_OPEN, private val types: Array<String> = emptyArray()) : FileChooserParams() {
        override fun getMode() = selectionMode
        override fun getAcceptTypes() = types
        override fun isCaptureEnabled() = false
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent()
    }

    @Test fun intentUsesReadOnlyDocumentsAndPreservesMultipleMimeHints() {
        var launched: Intent? = null
        val picker = NativeFilePicker(context) { launched = it }
        assertTrue(picker.open(Params(FileChooserParams.MODE_OPEN_MULTIPLE, arrayOf("text/plain", "application/zip")), { true }) { fail("Premature callback") })
        val intent = launched!!
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
        assertEquals("*/*", intent.type)
        assertArrayEquals(arrayOf("text/plain", "application/zip"), intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES))
        assertTrue(intent.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false))
        assertEquals(Intent.FLAG_GRANT_READ_URI_PERMISSION, intent.flags)
    }

    @Test fun mimeHintsKeepGenericFilesAndNormalizeArchives() {
        assertEquals(listOf("*/*"), NativeFilePicker.mimeTypes(emptyArray()))
        assertEquals(listOf("image/*"), NativeFilePicker.mimeTypes(arrayOf("IMAGE/*")))
        assertEquals(listOf("application/zip"), NativeFilePicker.mimeTypes(arrayOf(".zip, application/zip")))
        assertEquals(listOf("*/*"), NativeFilePicker.mimeTypes(arrayOf(".unknown-qwen-extension")))
        assertEquals(listOf("*/*"), NativeFilePicker.mimeTypes(arrayOf("text/plain\ninvalid")))
    }

    @Test fun unsupportedModeAndStaleDocumentCancelWithoutLaunching() {
        val calls = mutableListOf<Array<Uri>?>()
        val picker = NativeFilePicker(context) { fail("Must not launch") }
        picker.open(Params(FileChooserParams.MODE_SAVE), { true }, ValueCallback { calls.add(it) })
        picker.open(Params(), { false }, ValueCallback { calls.add(it) })
        assertEquals(2, calls.size)
        assertTrue(calls.all { it == null })
        assertFalse(picker.awaitingResult)
    }

    @Test fun cancellationKeepsOldPickerSlotUntilItsLateResultArrives() {
        val callsA = mutableListOf<Array<Uri>?>()
        val callsB = mutableListOf<Array<Uri>?>()
        var launches = 0
        val picker = NativeFilePicker(context) { launches++ }
        picker.open(Params(), { true }, ValueCallback { callsA.add(it) })
        picker.cancel()
        picker.cancel()
        assertTrue(picker.awaitingResult)
        picker.open(Params(), { true }, ValueCallback { callsB.add(it) })
        assertEquals(1, launches)
        picker.result(Activity.RESULT_OK, Intent().setData(Uri.parse("file:///private/never-send")))
        assertEquals(1, callsA.size)
        assertNull(callsA.single())
        assertEquals(1, callsB.size)
        assertNull(callsB.single())
        assertFalse(picker.awaitingResult)
        picker.open(Params(), { true }) { }
        assertEquals(2, launches)
    }

    @Test fun recreationDropsOrphanResultBeforeAllowingANewRequest() {
        var launches = 0
        var cancellations = 0
        val picker = NativeFilePicker(context) { launches++ }
        picker.restoreAwaitingResult(true)
        picker.open(Params(), { true }) { assertNull(it); cancellations++ }
        assertEquals(0, launches)
        assertEquals(1, cancellations)
        picker.result(Activity.RESULT_OK, Intent().setData(Uri.parse("content://orphan/document")))
        picker.open(Params(), { true }) { }
        assertEquals(1, launches)
    }

    @Test fun cancelledAndRepeatedResultsCompleteCallbackOnlyOnce() {
        var calls = 0
        val picker = NativeFilePicker(context) { }
        picker.open(Params(), { true }) { assertNull(it); calls++ }
        picker.result(Activity.RESULT_CANCELED, null)
        picker.result(Activity.RESULT_OK, Intent())
        picker.cancel()
        assertEquals(1, calls)
        assertFalse(picker.awaitingResult)
    }

    @Test fun unsafeAndUnreadableResultsFailClosed() {
        val results = listOf(
            Intent().setData(Uri.parse("file:///data/data/com.qwen.mobileshell/no_backup/connection-profiles.v1")),
            Intent().setData(Uri.parse("https://example.com/private")),
            Intent().setData(Uri.parse("content:///missing-authority")),
            Intent().setData(Uri.parse("content://missing-qwen-provider/document")),
            Intent().setData(android.provider.Settings.System.CONTENT_URI),
            Intent().apply { clipData = ClipData.newPlainText("not a file", "secret") },
        )
        val picker = NativeFilePicker(context) { }
        var calls = 0
        for (result in results) {
            picker.open(Params(), { true }) { assertNull(it); calls++ }
            picker.result(Activity.RESULT_OK, result.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            assertFalse(picker.awaitingResult)
        }
        assertEquals(results.size, calls)
    }

    @Test fun changedDocumentDiscardsResultAndMissingPickerCancels() {
        var current = true
        var calls = 0
        val picker = NativeFilePicker(context) { }
        picker.open(Params(), { current }) { assertNull(it); calls++ }
        current = false
        picker.result(Activity.RESULT_OK, Intent())
        instrumentation.runOnMainSync {
            val unavailable = NativeFilePicker(context) { throw ActivityNotFoundException() }
            unavailable.open(Params(), { true }) { assertNull(it); calls++ }
            assertFalse(unavailable.awaitingResult)
        }
        assertEquals(2, calls)
    }
}
