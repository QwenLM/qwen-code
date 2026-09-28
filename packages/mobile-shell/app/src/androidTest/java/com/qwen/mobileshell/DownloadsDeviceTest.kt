package com.qwen.mobileshell

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebMessageCompat
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32

@RunWith(AndroidJUnit4::class)
class DownloadsDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val id = "0123456789abcdef0123456789abcdef"

    private class Fixture(context: android.content.Context) {
        val intents = CopyOnWriteArrayList<Intent>()
        val replies = mutableListOf<JSONObject>()
        var current = true
        val downloads = NativeDownloads(context) { intents.add(it) }
        fun send(text: String) { downloads.receive(WebMessageCompat(text), { current }) { replies.add(JSONObject(it)) } }
        fun state() = replies.last().getString("state")
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
        assertEquals("_report.txt", intent.getStringExtra(Intent.EXTRA_TITLE))
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
            it.send(begin(size))
            assertEquals("error", it.state())
        }
        it.send(JSONObject(begin()).put("v", 2).toString())
        assertEquals("error", it.state())
        it.send(begin(1))
        it.send(command("finish"))
        assertEquals("error", it.state())
        assertTrue(it.intents.isEmpty())
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

    @Test fun navigationKeepsOldPickerSlotReservedUntilItsResultArrives() = fixture {
        it.send(begin())
        it.send(command("finish"))
        it.current = false
        it.downloads.cancel()
        assertTrue(it.downloads.awaitingResult)
        it.current = true
        it.send(begin(0, "f".repeat(32)))
        assertEquals("error", it.state())
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

    @Test fun cancellationDuringProviderWriteFinishesTheFileWithoutStaleSuccess() {
        val uri = DownloadsFixtureProvider.URI
        fun provider(method: String) = context.contentResolver.call(uri, method, null, null)!!
        fun awaitProvider(predicate: (android.os.Bundle) -> Boolean): android.os.Bundle {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            do {
                val state = provider("status")
                if (predicate(state)) return state
                Thread.sleep(20)
            } while (System.nanoTime() < deadline)
            throw AssertionError("Provider did not reach the expected state")
        }
        val bytes = ByteArray(4 * 1024 * 1024) { (it % 251).toByte() }
        lateinit var fixture: Fixture
        provider("grant")
        try {
            instrumentation.runOnMainSync {
                fixture = Fixture(context)
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
            var cancelledState = ""
            instrumentation.runOnMainSync {
                fixture.downloads.cancel()
                cancelledState = fixture.state()
                fixture.current = false
            }
            assertEquals("cancelled", cancelledState)
            provider("resume")
            val state = awaitProvider { it.getBoolean("done") }
            assertNull("Provider must finish without I/O errors", state.getString("error"))
            assertEquals("Cancelling after writing starts must preserve the whole file", bytes.size, state.getInt("count"))
            assertEquals(CRC32().apply { update(bytes) }.value, state.getLong("crc"))
            // Wait for the writer's main-thread completion by retrying a new transfer.
            var ready = false
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!ready && System.nanoTime() < deadline) {
                instrumentation.runOnMainSync {
                    fixture.current = true
                    fixture.send(begin(0, "f".repeat(32)))
                    ready = fixture.state() == "ready"
                }
                if (!ready) Thread.sleep(20)
            }
            assertTrue("Writer must release its slot", ready)
            var saved = false
            instrumentation.runOnMainSync {
                saved = fixture.replies.any { it.getString("state") == "saved" }
                fixture.downloads.cancel()
            }
            assertFalse("A cancelled transfer must not report success", saved)
        } finally {
            provider("resume")
            instrumentation.runOnMainSync { fixture.downloads.cancel() }
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
            val script = "qwenAndroidDownloadV1.postMessage(${JSONObject.quote(begin())}); qwenAndroidDownloadV1.postMessage(${JSONObject.quote(command("finish"))});"
            load(view!!, "https://download-test.example/", "<html><iframe srcdoc=\"&lt;script&gt;${script.replace("\"", "&quot;")} window.attempted = true;&lt;/script&gt;\"></iframe></html>")
            assertEquals("\"object\"", evaluate(view!!, "typeof qwenAndroidDownloadV1"))
            assertEquals("true", evaluate(view!!, "document.querySelector('iframe').contentDocument.readyState === 'complete'"))
            assertEquals("true", evaluate(view!!, "document.querySelector('iframe').contentWindow.attempted === true"))
            instrumentation.waitForIdleSync()
            assertTrue(intents.isEmpty())
            evaluate(view!!, script)
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (intents.isEmpty() && System.nanoTime() < deadline) Thread.sleep(25)
            assertEquals(1, intents.size)
        } finally {
            instrumentation.runOnMainSync { downloads?.cancel(); view?.destroy() }
        }
    }

    private fun load(view: WebView, origin: String, html: String) {
        val done = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) { done.countDown() }
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
