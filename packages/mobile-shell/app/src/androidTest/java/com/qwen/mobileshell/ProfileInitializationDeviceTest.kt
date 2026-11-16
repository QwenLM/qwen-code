package com.qwen.mobileshell

import android.annotation.SuppressLint
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.Closeable
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the real Connect path without an external daemon or erasing app data. */
@RunWith(AndroidJUnit4::class)
class ProfileInitializationDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun staleUninitializedProfileClearsBeforeLoadThenReconnectPreserves() {
        val supported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)
        if (InstrumentationRegistry.getArguments().getString("requireProfileIsolation") == "true") {
            assertTrue("This acceptance lane requires completed profile clearing", supported)
        }
        assumeTrue(supported)
        LocalFixture().use { fixture ->
            withSyntheticProfile(fixture.origin) { profile ->
                seedStorage(profile)
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    lateinit var activity: MainActivity
                    scenario.onActivity { activity = it }
                    clickConnect(activity, profile)
                    val view = awaitLoadedView(activity)
                    val initial = JSONObject(evaluate(view, "window.guardInitial"))
                    assertTrue(initial.isNull("workspace"))
                    assertEquals("", initial.getString("cookie"))
                    assertFalse(initial.getJSONArray("databases").toString().contains("guard-stale-db"))
                    assertFalse(initial.getJSONArray("caches").toString().contains("guard-stale-cache"))
                    assertEquals("The first HTTP request must not carry the stale cookie", "", fixture.documentCookies.first())
                    assertTrue(AndroidProfileStore(context).vault.load().profiles.single { it.id == profile.id }.browserInitialized)
                    instrumentation.runOnMainSync {
                        assertEquals(profile.browserName, WebViewCompat.getProfile(view).name)
                    }

                    evaluate(view, "localStorage.setItem('guardWorkspace','FRESH');document.cookie='guardIdentity=FRESH; path=/'")
                    clickButton(activity, activity.getString(R.string.connection_controls, profile.name))
                    clickConnect(activity, profile)
                    val reopened = JSONObject(evaluate(awaitLoadedView(activity), "window.guardInitial"))
                    assertEquals("FRESH", reopened.getString("workspace"))
                    assertEquals("guardIdentity=FRESH", reopened.getString("cookie"))
                    assertNull("The embedded fixture failed", fixture.failure.get())
                }
            }
        }
    }

    @Test fun oldProviderFailsClosedBeforeCreatingNamedProfileOrWebView() {
        assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) &&
            !WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA))
        LocalFixture().use { fixture ->
            withSyntheticProfile(fixture.origin) { profile ->
                instrumentation.runOnMainSync {
                    assertFalse(ProfileStore.getInstance().allProfileNames.contains(profile.browserName))
                }
                ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                    lateinit var activity: MainActivity
                    scenario.onActivity { activity = it }
                    clickConnect(activity, profile)
                    await("The provider update message was not shown") {
                        var shown = false
                        instrumentation.runOnMainSync {
                            shown = allViews(activity.window.decorView).filterIsInstance<TextView>()
                                .any { it.text.toString() == activity.getString(R.string.provider_update) }
                        }
                        shown
                    }
                    instrumentation.runOnMainSync {
                        assertTrue(allViews(activity.window.decorView).filterIsInstance<WebView>().isEmpty())
                        assertFalse(ProfileStore.getInstance().allProfileNames.contains(profile.browserName))
                    }
                    assertFalse(AndroidProfileStore(context).vault.load().profiles.single { it.id == profile.id }.browserInitialized)
                    assertEquals("Unsupported providers must not contact the daemon", 0, fixture.requests.get())
                }
            }
        }
    }

    private fun withSyntheticProfile(origin: String, body: (ConnectionProfile) -> Unit) {
        val store = AndroidProfileStore(context)
        val profile = ConnectionProfile.create("Initialization test ${UUID.randomUUID()}", origin, null)
        try {
            store.vault.upsert(store.vault.load(), profile)
            body(profile)
        } finally {
            try {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
                    val cleared = CountDownLatch(1)
                    instrumentation.runOnMainSync {
                        val browser = ProfileStore.getInstance().getProfile(profile.browserName)
                        if (browser == null) cleared.countDown()
                        else WebStorageCompat.deleteBrowsingData(browser.webStorage) { cleared.countDown() }
                    }
                    assertTrue("Synthetic browser cleanup did not finish", cleared.await(15, TimeUnit.SECONDS))
                }
            } finally {
                val latest = store.vault.load()
                latest.profiles.find { it.id == profile.id }?.let { store.vault.remove(latest, it) }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun seedStorage(profile: ConnectionProfile) {
        lateinit var view: WebView
        val loaded = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view = WebView(context).apply {
                WebViewCompat.setProfile(this, profile.browserName)
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true
                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) { loaded.countDown() }
                }
                loadDataWithBaseURL(profile.origin, "<html><body>Storage seed</body></html>", "text/html", "UTF-8", null)
            }
        }
        try {
            assertTrue("Seed page did not load", loaded.await(15, TimeUnit.SECONDS))
            evaluate(view, """
                window.seedReady=false;window.seedError=null;
                (async()=>{try{
                  localStorage.setItem('guardWorkspace','STALE');document.cookie='guardIdentity=STALE; path=/';
                  await new Promise((resolve,reject)=>{
                    const request=indexedDB.open('guard-stale-db',1);
                    request.onupgradeneeded=()=>request.result.createObjectStore('items');
                    request.onerror=()=>reject(request.error);
                    request.onsuccess=()=>{
                      const db=request.result;const tx=db.transaction('items','readwrite');
                      tx.objectStore('items').put('stale','value');
                      tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>reject(tx.error);
                    };
                  });
                  const cache=await caches.open('guard-stale-cache');
                  await cache.put('/guard-stale-resource',new Response('stale'));
                  window.seedReady=true;
                }catch(error){window.seedError=String(error)}})()
            """.trimIndent())
            await("Synthetic storage seed did not finish") {
                evaluate(view, "window.seedReady===true||typeof window.seedError==='string'") == "true"
            }
            assertEquals("null", evaluate(view, "window.seedError"))
            assertEquals("\"STALE\"", evaluate(view, "localStorage.getItem('guardWorkspace')"))
            assertEquals("\"guardIdentity=STALE\"", evaluate(view, "document.cookie"))
        } finally { instrumentation.runOnMainSync { view.destroy() } }
    }

    private fun clickConnect(activity: MainActivity, profile: ConnectionProfile) {
        instrumentation.runOnMainSync {
            val views = allViews(activity.window.decorView)
            val title = views.indexOfFirst { it is TextView && it.text.toString() == profile.name }
            assertTrue("Synthetic profile is missing from the native list", title >= 0)
            assertTrue(views.drop(title + 1).filterIsInstance<Button>()
                .first { it.text.toString().equals(activity.getString(R.string.connect), true) }.performClick())
        }
    }

    private fun clickButton(activity: MainActivity, label: String) {
        instrumentation.runOnMainSync {
            assertTrue(allViews(activity.window.decorView).filterIsInstance<Button>()
                .first { it.text.toString().equals(label, true) }.performClick())
        }
    }

    private fun awaitLoadedView(activity: MainActivity): WebView {
        var view: WebView? = null
        await("Connect did not create a WebView") {
            instrumentation.runOnMainSync {
                view = allViews(activity.window.decorView).filterIsInstance<WebView>().singleOrNull()
            }
            view != null
        }
        await("The embedded fixture did not load") {
            evaluate(view!!, "window.guardReady===true||typeof window.guardError==='string'") == "true"
        }
        assertEquals("null", evaluate(view!!, "window.guardError"))
        return view!!
    }

    private fun allViews(view: View): List<View> = listOf(view) + if (view is ViewGroup) {
        (0 until view.childCount).flatMap { allViews(view.getChildAt(it)) }
    } else emptyList()

    private fun await(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15_000
        while (!predicate()) {
            assertTrue(message, SystemClock.uptimeMillis() < deadline)
            SystemClock.sleep(50)
        }
    }

    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; done.countDown() } }
        assertTrue("JavaScript evaluation did not finish", done.await(10, TimeUnit.SECONDS))
        return result
    }

    private class LocalFixture : Closeable {
        private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${server.localPort}/"
        val requests = AtomicInteger()
        val documentCookies: MutableList<String> = Collections.synchronizedList(mutableListOf())
        val failure = AtomicReference<Throwable?>()
        @Volatile private var activeSocket: Socket? = null
        private val worker = Thread({
            try {
                while (!server.isClosed) {
                    server.accept().use { socket ->
                        activeSocket = socket
                        socket.soTimeout = 3_000
                        val input = socket.getInputStream().bufferedReader(Charsets.US_ASCII)
                        val request = input.readLine() ?: return@use
                        requests.incrementAndGet()
                        var cookie = ""
                        while (true) {
                            val header = input.readLine() ?: break
                            if (header.isEmpty()) break
                            if (header.startsWith("Cookie:", true)) cookie = header.substringAfter(':').trim()
                        }
                        val document = request.substringAfter(' ').substringBefore(' ') == "/"
                        if (document) documentCookies.add(cookie)
                        val body = if (document) PAGE.toByteArray(Charsets.UTF_8) else byteArrayOf()
                        val headers = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
                            "Content-Length: ${body.size}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
                        socket.getOutputStream().apply {
                            write(headers.toByteArray(Charsets.US_ASCII))
                            write(body)
                            flush()
                        }
                    }
                    activeSocket = null
                }
            } catch (error: Exception) {
                if (!server.isClosed) failure.set(error)
            }
        }, "profile-initialization-fixture").apply { isDaemon = true; start() }

        override fun close() {
            server.close()
            activeSocket?.close()
            worker.join(5_000)
        }

        companion object {
            private val PAGE = """
                <!doctype html><meta charset="utf-8"><script>
                window.guardReady=false;window.guardError=null;
                window.guardInitial={workspace:localStorage.getItem('guardWorkspace'),cookie:document.cookie};
                (async()=>{try{
                  window.guardInitial.databases=(await indexedDB.databases()).map(db=>db.name);
                  window.guardInitial.caches=await caches.keys();
                  window.guardReady=true;
                }catch(error){window.guardError=String(error)}})();
                </script><body>Profile initialization fixture</body>
            """.trimIndent()
        }
    }
}
