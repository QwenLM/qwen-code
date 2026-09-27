package com.qwen.mobileshell

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FilePickerDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private var fixtureUsed = false

    @After fun revokeFixtureGrants() {
        if (fixtureUsed) context.contentResolver.call(FilePickerFixtureProvider.BASE_URI, "reset", null, null)
    }

    private fun document(index: Int = 0, granted: Boolean = true): Uri {
        if (!fixtureUsed) context.contentResolver.call(FilePickerFixtureProvider.BASE_URI, "reset", null, null)
        fixtureUsed = true
        val uri = FilePickerFixtureProvider.uri(index)
        if (granted) context.contentResolver.call(FilePickerFixtureProvider.BASE_URI, "grant", index.toString(), null)
        val provider = requireNotNull(context.packageManager.resolveContentProvider(uri.authority!!, 0))
        assertNotEquals("Fixture must be owned by a different UID", context.applicationInfo.uid, provider.applicationInfo.uid)
        assertEquals("Fixture URI grant", if (granted) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED,
            context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION))
        return uri
    }

    private fun selection(uris: List<Uri>) = Intent().apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        clipData = ClipData.newRawUri("synthetic files", uris.first()).also { clip ->
            uris.drop(1).forEach { clip.addItem(ClipData.Item(it)) }
        }
    }

    private fun delivered(result: Intent, multiple: Boolean = true, pickerContext: Context = context): Array<Uri>? {
        val calls = mutableListOf<Array<Uri>?>()
        val picker = NativeFilePicker(pickerContext) { }
        picker.open(Params(if (multiple) FileChooserParams.MODE_OPEN_MULTIPLE else FileChooserParams.MODE_OPEN), { true }) { calls.add(it) }
        picker.result(Activity.RESULT_OK, result)
        assertEquals("Result must complete the callback once", 1, calls.size)
        assertFalse("Result must release the picker slot", picker.awaitingResult)
        return calls.single()
    }

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

    @Test fun singleMimeHintBecomesTheIntentType() {
        var launched: Intent? = null
        NativeFilePicker(context) { launched = it }.open(Params(types = arrayOf("IMAGE/*")), { true }) { }
        assertEquals("image/*", launched!!.type)
        assertFalse(launched!!.hasExtra(Intent.EXTRA_MIME_TYPES))
        assertFalse(launched!!.getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, true))
    }

    @Test fun singleGrantedDocumentDeliversReadableSyntheticBytes() {
        val uri = document()
        val actual = delivered(Intent().setData(uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), multiple = false)
        assertArrayEquals(arrayOf(uri), actual)
        val bytes = context.contentResolver.openInputStream(actual!!.single())!!.use { it.readBytes() }
        assertArrayEquals(FilePickerFixtureProvider.contents(0), bytes)
    }

    @Test fun multipleGrantedDocumentsPreserveOrderAndRemoveDuplicates() {
        val uris = (0..2).map { document(it) }
        val actual = delivered(selection(uris + uris.first()).setData(uris.first()))
        assertArrayEquals(uris.toTypedArray(), actual)
        actual!!.forEachIndexed { index, uri ->
            val bytes = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            assertArrayEquals(FilePickerFixtureProvider.contents(index), bytes)
        }
    }

    @Test fun singleModeRejectsSeveralOtherwiseValidDocuments() {
        assertNull(delivered(selection(listOf(document(0), document(1))), multiple = false))
    }

    @Test fun readGrantFlagAndActualGrantAreBothRequired() {
        assertNull(delivered(Intent().setData(document(0))))
        assertNull(delivered(selection(listOf(document(1, granted = false)))))
    }

    @Test fun providerOwnedByPickerContextIsRejectedDespiteReadGrant() {
        val uri = document()
        val provider = requireNotNull(context.packageManager.resolveContentProvider(uri.authority!!, 0))
        val ownerInfo = context.packageManager.getApplicationInfo(provider.packageName, 0)
        // Instrumentation's synthetic ApplicationInfo can have UID 0 on older Android.
        val ownerContext = object : ContextWrapper(context) {
            override fun getApplicationInfo() = ownerInfo
        }
        assertEquals("Picker context must belong to the provider UID", provider.applicationInfo.uid, ownerContext.applicationInfo.uid)
        assertArrayEquals("Control: a different-UID context accepts the granted URI", arrayOf(uri), delivered(selection(listOf(uri))))
        assertNull(delivered(selection(listOf(uri)), pickerContext = ownerContext))
    }

    @Test fun mixedSelectionRejectsAllFilesWhenOneIsUnsafe() {
        assertNull(delivered(selection(listOf(document(), Uri.parse("file:///synthetic-never-read.txt")))))
    }

    @Test fun oneHundredDocumentsAreAcceptedAndOneHundredOneAreRejected() {
        val uris = (0..100).map { document(it) }
        assertArrayEquals(uris.take(100).toTypedArray(), delivered(selection(uris.take(100))))
        assertNull(delivered(selection(uris)))
        assertNull(delivered(selection(uris.take(100)).setData(uris.last())))
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

    @Test fun changedDocumentDiscardsAnOtherwiseValidGrantedResult() {
        val uri = document()
        val result = selection(listOf(uri))
        assertArrayEquals("Control: this URI must be accepted for a current document", arrayOf(uri), delivered(result))
        var current = true
        var calls = 0
        val picker = NativeFilePicker(context) { }
        picker.open(Params(), { current }) { assertNull(it); calls++ }
        current = false
        picker.result(Activity.RESULT_OK, result)
        assertEquals(1, calls)
        assertFalse(picker.awaitingResult)
    }

    @Test fun missingPickerCancelsAndReleasesSlot() {
        var calls = 0
        instrumentation.runOnMainSync {
            val unavailable = NativeFilePicker(context) { throw ActivityNotFoundException() }
            unavailable.open(Params(), { true }) { assertNull(it); calls++ }
            assertFalse(unavailable.awaitingResult)
        }
        assertEquals(1, calls)
    }
}
