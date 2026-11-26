package com.qwen.mobileshell

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebMessageCompat
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.io.ByteArrayInputStream
import java.io.FileNotFoundException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32

@RunWith(AndroidJUnit4::class)
class DownloadsDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val id = "0123456789abcdef0123456789abcdef"

    private fun provider(method: String, arg: String? = null): Bundle =
        context.contentResolver.call(DownloadsFixtureProvider.URI, method, arg, null)!!

    @Before @After fun resetFixtureGrants() {
        provider("reset")
        assertEquals(PackageManager.PERMISSION_DENIED,
            context.checkUriPermission(DownloadsFixtureProvider.URI, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
    }

    private class Fixture(context: android.content.Context) {
        val intents = CopyOnWriteArrayList<Intent>()
        val replies = mutableListOf<JSONObject>()
        var current = true
        val downloads = NativeDownloads(context) { intents.add(it) }
        fun send(text: String) { downloads.receive(WebMessageCompat(text), { current }) { replies.add(JSONObject(it)) } }
        fun state() = replies.last().getString("state")
        fun reject(text: String, error: String) {
            val count = replies.size
            send(text)
            assertEquals("A rejected command must receive its own reply", count + 1, replies.size)
            assertEquals("error", state())
            assertEquals(error, replies.last().getString("error"))
        }
    }

    private fun begin(size: Int = 0, transfer: String = id) = JSONObject()
        .put("v", 1).put("id", transfer).put("op", "begin").put("name", "../report.txt")
        .put("mime", "text/plain").put("size", size).toString()
    private fun command(op: String, transfer: String = id) = JSONObject().put("v", 1).put("id", transfer).put("op", op).toString()
    private fun fixture(test: (Fixture) -> Unit) {
        instrumentation.runOnMainSync {
            val fixture = Fixture(context)
            try { test(fixture) } finally { fixture.downloads.cancel() }
        }
    }

    @Test fun emptyDownloadOpensScopedCreateDocumentAndCancelAllowsRetry() = fixture {
        it.send(begin())
        assertEquals("ready", it.state())
        it.send(command("finish"))
        assertEquals("choosing", it.state())
        val intent = it.intents.single()
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertEquals(".._report.txt", intent.getStringExtra(Intent.EXTRA_TITLE))
        assertEquals("text/plain", intent.type)
        assertEquals(Intent.FLAG_GRANT_WRITE_URI_PERMISSION, intent.flags)
        assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
        it.downloads.result(Activity.RESULT_CANCELED, null)
        assertEquals("cancelled", it.state())
        it.send(begin())
        assertEquals("ready", it.state())
    }

    @Test fun rejectsInvalidSizesVersionAndIncompleteDataWithoutOpeningPicker() = fixture {
        for (size in listOf(-1, DownloadBuffer.MAX_SIZE + 1)) {
            it.reject(begin(size), "Android downloads are limited to 16 MiB.")
        }
        it.reject(JSONObject(begin()).put("v", 2).toString(), "Unsupported download protocol.")
        it.reject(command("unsupported"), "Unsupported download command.")
        it.send(begin(1))
        it.send(command("finish"))
        assertEquals("error", it.state())
        assertTrue(it.intents.isEmpty())
        it.send(begin())
        assertEquals("ready", it.state())
    }

    @Test fun metadataByteLimitDropsOversizedCommandsWithoutPoisoningTheSlot() = fixture {
        val text = JSONObject(begin()).put("name", "文".repeat(800)).toString()
        assertTrue(text.length < 2048)
        assertTrue(text.toByteArray(Charsets.UTF_8).size > 2048)
        it.send(text)
        assertTrue(it.replies.isEmpty())
        assertTrue(it.intents.isEmpty())
        it.send(begin())
        assertEquals("ready", it.state())
    }

    @Test fun mimeParametersAreRemovedAndInvalidTypesFallBack() = fixture {
        for ((mime, expected) in listOf("TEXT/PLAIN; charset=UTF-8" to "text/plain", "invalid type" to "application/octet-stream")) {
            it.send(JSONObject(begin()).put("mime", mime).toString())
            assertEquals("ready", it.state())
            it.send(command("finish"))
            assertEquals(expected, it.intents.last().type)
            it.downloads.result(Activity.RESULT_CANCELED, null)
        }
        assertEquals(2, it.intents.size)
    }

    @Test fun inactiveMessagesAndCallbacksCannotAdvanceTheTransfer() = fixture {
        it.current = false
        it.send(begin())
        assertTrue(it.replies.isEmpty())
        it.current = true
        it.send(begin(1))
        assertEquals("ready", it.state())
        val replies = it.replies.size
        it.current = false
        it.downloads.cancel()
        assertEquals(replies, it.replies.size)
        it.current = true
        it.send(begin())
        assertEquals("ready", it.state())
    }

    @Test fun malformedOrStaleCommandsCannotAdoptAnotherTransfer() = fixture {
        it.send("not json")
        it.send(JSONObject(begin()).put("id", "bad").toString())
        assertTrue(it.replies.isEmpty())
        it.send(begin(1))
        it.send(begin(0, "f".repeat(32)))
        assertEquals("error", it.state())
        it.send(command("cancel", "f".repeat(32)))
        val frame = ByteBuffer.allocate(37).put(id.toByteArray()).putInt(0).put(7.toByte()).array()
        it.downloads.receive(WebMessageCompat(frame), { true }) { error("Binary ACK must use original reply") }
        assertEquals("chunk", it.state())
        assertEquals(1, it.replies.last().getInt("offset"))
        it.send(command("finish"))
        assertEquals(1, it.intents.size)
    }

    @Test fun matchingCancelCompletesOnceAndAllowsANewTransfer() = fixture {
        it.send(begin(1))
        it.send(command("cancel"))
        assertEquals(listOf("ready", "cancelled"), it.replies.map { reply -> reply.getString("state") })
        it.send(command("cancel"))
        assertEquals(2, it.replies.size)
        assertFalse(it.downloads.awaitingResult)
        assertTrue(it.intents.isEmpty())
        it.send(begin(0, "f".repeat(32)))
        assertEquals("ready", it.state())
    }

    @Test fun aLateFrameCannotModifyACompletedTransferWhileChoosing() = fixture {
        it.send(begin())
        it.send(command("finish"))
        val replies = it.replies.size
        val frame = ByteBuffer.allocate(37).put(id.toByteArray()).putInt(0).put(7.toByte()).array()
        it.downloads.receive(WebMessageCompat(frame), { true }) { error("Unexpected binary reply") }
        assertEquals(replies, it.replies.size)
        assertEquals("choosing", it.state())
        assertTrue(it.downloads.awaitingResult)
        assertEquals(1, it.intents.size)
    }

    @Test fun strayAndRepeatedResultsCannotCancelANewUnfinishedTransfer() = fixture {
        it.send(begin())
        val replies = it.replies.size
        it.downloads.result(Activity.RESULT_CANCELED, null)
        assertEquals(replies, it.replies.size)
        it.send(command("finish"))
        assertEquals("choosing", it.state())
        it.downloads.result(Activity.RESULT_CANCELED, null)
        assertEquals("cancelled", it.state())
        it.send(begin(0, "f".repeat(32)))
        val nextReplies = it.replies.size
        it.downloads.result(Activity.RESULT_CANCELED, null)
        assertEquals(nextReplies, it.replies.size)
        it.send(command("finish", "f".repeat(32)))
        assertEquals("choosing", it.state())
        assertEquals(2, it.intents.size)
    }

    @Test fun grantedProviderWithoutAnActualWriteGrantIsRejected() = fixture {
        provider("grant")
        provider("reset")
        it.send(begin())
        it.send(command("finish"))
        it.downloads.result(Activity.RESULT_OK, Intent().setData(DownloadsFixtureProvider.URI).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
        assertEquals("error", it.state())
        assertFalse(it.downloads.awaitingResult)
        assertFalse(provider("status").getBoolean("opened"))
    }

    @Test fun fixturePipeFailureAllowsOpeningAgainWithoutAnotherGrant() {
        provider("grant", "fail-pipe")
        try {
            context.contentResolver.openOutputStream(DownloadsFixtureProvider.URI, "wt")?.close()
            fail("The injected pipe failure must be observed")
        } catch (_: FileNotFoundException) { }
        assertFalse(provider("status").getBoolean("opened"))
        context.contentResolver.openOutputStream(DownloadsFixtureProvider.URI, "wt")!!.use {
            assertFalse("A retry reader is active until its stream closes", provider("status").getBoolean("done"))
        }
    }

    @Test fun navigationKeepsOldPickerSlotReservedUntilItsResultArrives() = fixture {
        it.send(begin())
        it.send(command("finish"))
        it.current = false
        it.downloads.cancel()
        assertTrue(it.downloads.awaitingResult)
        it.current = true
        it.send(begin(0, "f".repeat(32)))
        assertEquals("error", it.state())
        assertEquals(1, it.intents.size)
        val count = it.replies.size
        it.downloads.result(Activity.RESULT_OK, Intent().setData(Uri.parse("file:///invalid")))
        assertEquals(count, it.replies.size)
        it.send(begin(0, "f".repeat(32)))
        assertEquals("ready", it.state())
    }

    @Test fun recreatedActivityDoesNotAttachAnOldPickerResultToNewBytes() = fixture {
        it.downloads.restoreAwaitingResult(true)
        it.send(begin())
        assertEquals("error", it.state())
        it.downloads.result(Activity.RESULT_OK, Intent().setData(Uri.parse("content://stale/file")))
        assertFalse(it.downloads.awaitingResult)
        it.send(begin())
        assertEquals("ready", it.state())
    }

    @Test fun rejectsUntrustedDestinationsAndMissingGrants() = fixture {
        for (result in listOf(
            Intent().setData(Uri.parse("file:///sdcard/file")),
            Intent().setData(Uri.parse("content://unregistered.provider/file")).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION),
            Intent().setData(Uri.parse("content://com.android.providers.downloads.documents/document/1")),
        )) {
            it.send(begin())
            it.send(command("finish"))
            it.downloads.result(Activity.RESULT_OK, result)
            assertEquals("error", it.state())
            assertFalse(it.downloads.awaitingResult)
        }
    }

    @Test fun unavailablePickerReportsErrorAndReleasesTransfer() {
        instrumentation.runOnMainSync {
            val replies = mutableListOf<JSONObject>()
            val downloads = NativeDownloads(context) { throw android.content.ActivityNotFoundException() }
            fun send(text: String) { downloads.receive(WebMessageCompat(text), { true }) { replies.add(JSONObject(it)) } }
            send(begin())
            send(command("finish"))
            assertEquals("error", replies.last().getString("state"))
            assertFalse(downloads.awaitingResult)
            send(begin())
            assertEquals("ready", replies.last().getString("state"))
            downloads.cancel()
        }
    }

    @Test fun cancellationDuringProviderWriteFinishesTheFileWithoutSuccessOnCurrentPage() =
        providerWriteCompletes(cancel = true)

    @Test fun successfulProviderWriteReportsSavedOnceForTheMatchingTransfer() =
        providerWriteCompletes(cancel = false)

    private fun providerWriteCompletes(cancel: Boolean) {
        val uri = DownloadsFixtureProvider.URI
        fun awaitProvider(predicate: (android.os.Bundle) -> Boolean): android.os.Bundle {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            do {
                val state = provider("status")
                if (predicate(state)) return state
                Thread.sleep(20)
            } while (System.nanoTime() < deadline)
            throw AssertionError("Provider did not reach the expected state")
        }
        val bytes = ByteArray(4 * 1024 * 1024) { (it % 251).toByte() }
        lateinit var fixture: Fixture
        instrumentation.runOnMainSync { fixture = Fixture(context) }
        provider("grant")
        try {
            instrumentation.runOnMainSync {
                fixture.send(begin(bytes.size))
                for (offset in bytes.indices step DownloadBuffer.CHUNK_SIZE) {
                    val chunk = bytes.copyOfRange(offset, minOf(offset + DownloadBuffer.CHUNK_SIZE, bytes.size))
                    val frame = ByteBuffer.allocate(DownloadBuffer.HEADER_SIZE + chunk.size)
                        .put(id.toByteArray(Charsets.US_ASCII)).putInt(offset).put(chunk).array()
                    fixture.downloads.receive(WebMessageCompat(frame), { true }) { error("Unexpected binary reply") }
                }
                fixture.send(command("finish"))
                fixture.downloads.result(Activity.RESULT_OK, Intent().setData(uri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION))
            }
            awaitProvider { it.getInt("count") > 0 }
            if (cancel) {
                instrumentation.runOnMainSync {
                    fixture.downloads.cancel()
                    assertEquals("cancelled", fixture.state())
                    assertTrue("Cancellation must be tested independently of a stale page", fixture.current)
                }
            }
            provider("resume")
            val state = awaitProvider { it.getBoolean("done") }
            assertNull("Provider must finish without I/O errors", state.getString("error"))
            assertEquals("The provider must receive the whole file", bytes.size, state.getInt("count"))
            assertEquals(CRC32().apply { update(bytes) }.value, state.getLong("crc"))
            // Wait for the writer's main-thread completion by retrying a new transfer.
            var ready = false
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!ready && System.nanoTime() < deadline) {
                instrumentation.runOnMainSync {
                    fixture.send(begin(0, "f".repeat(32)))
                    ready = fixture.state() == "ready"
                }
                if (!ready) Thread.sleep(20)
            }
            assertTrue("Writer must release its slot", ready)
            instrumentation.runOnMainSync {
                val terminalStates = fixture.replies.filter { it.getString("id") == id }
                    .map { it.getString("state") }.filter { it in listOf("saved", "cancelled", "error") }
                assertEquals(listOf(if (cancel) "cancelled" else "saved"), terminalStates)
                fixture.downloads.cancel()
            }
        } finally {
            provider("resume")
            instrumentation.runOnMainSync { fixture.downloads.cancel() }
            awaitProvider { it.getBoolean("done") }
        }
    }

    @Test fun bridgeIsOriginRestrictedAndSameOriginSubframesCannotOpenPicker() {
        var view: WebView? = null
        var downloads: NativeDownloads? = null
        val intents = CopyOnWriteArrayList<Intent>()
        try {
            var supported = false
            instrumentation.runOnMainSync {
                view = WebView(context).apply { settings.javaScriptEnabled = true }
                downloads = NativeDownloads(context) { intents.add(it) }
                supported = downloads!!.install(view!!, "https://download-test.example/") { true }
            }
            assumeTrue(supported)
            load(view!!, "https://foreign.example/", "<html>foreign</html>")
            assertEquals("\"undefined\"", evaluate(view!!, "typeof qwenAndroidDownloadV1"))
            val frameBegin = JSONObject(begin()).put("name", "frame.txt").toString()
            val script = "qwenAndroidDownloadV1.postMessage(${JSONObject.quote(frameBegin)}); qwenAndroidDownloadV1.postMessage(${JSONObject.quote(command("finish"))});"
            val frame = "<script>$script window.attempted = true;</script>"
            load(view!!, "https://download-test.example/", "<html><iframe src=\"https://download-test.example/frame\"></iframe></html>", frame)
            assertEquals("\"object\"", evaluate(view!!, "typeof qwenAndroidDownloadV1"))
            assertEquals("true", evaluate(view!!, "document.querySelector('iframe').contentDocument.readyState === 'complete'"))
            assertEquals("true", evaluate(view!!, "document.querySelector('iframe').contentWindow.attempted === true"))
            assertEquals("\"https://download-test.example\"", evaluate(view!!, "document.querySelector('iframe').contentWindow.location.origin"))
            instrumentation.waitForIdleSync()
            assertTrue(intents.isEmpty())
            val mainBegin = JSONObject(begin()).put("name", "main.txt").toString()
            evaluate(view!!, "qwenAndroidDownloadV1.postMessage(${JSONObject.quote(mainBegin)}); qwenAndroidDownloadV1.postMessage(${JSONObject.quote(command("finish"))});")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (intents.isEmpty() && System.nanoTime() < deadline) Thread.sleep(25)
            assertEquals(1, intents.size)
            assertEquals("main.txt", intents.single().getStringExtra(Intent.EXTRA_TITLE))
        } finally {
            instrumentation.runOnMainSync { downloads?.cancel(); view?.destroy() }
        }
    }

    private fun load(view: WebView, origin: String, html: String, frame: String? = null) {
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { done.countDown() }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    if (frame != null && request.url.toString() == "https://download-test.example/frame")
                        WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(frame.toByteArray()))
                    else null
            }
            view.loadDataWithBaseURL(origin, html, "text/html", "UTF-8", null)
        }
        assertTrue(done.await(15, TimeUnit.SECONDS))
    }

    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; done.countDown() } }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        return result
    }
}
