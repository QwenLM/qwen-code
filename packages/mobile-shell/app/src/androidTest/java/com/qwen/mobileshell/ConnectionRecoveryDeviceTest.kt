package com.qwen.mobileshell

import android.os.Build
import android.os.Bundle
import android.os.Parcel
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
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
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConnectionRecoveryDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val store get() = AndroidProfileStore(instrumentation.targetContext)
    private val route = "/session/recovery-session?workspace=recovery-workspace&context=live"

    @Test fun recreationRestoresFreshAuthenticatedViewWithoutSavingCredentials() = withFixture { fixture, profile ->
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var activity = activity(scenario)
            val original = connect(activity, profile)
            navigate(original)
            val saved = Bundle()
            instrumentation.runOnMainSync { instrumentation.callActivityOnSaveInstanceState(activity, saved) }
            val snapshot = saved.getBundle("connection-recovery")!!
            assertEquals(setOf("profile", "browser", "session", "workspace", "context", "retry"), snapshot.keySet())
            val parcel = Parcel.obtain()
            try {
                parcel.writeBundle(saved)
                val bytes = parcel.marshall()
                assertFalse(String(bytes, Charsets.UTF_16LE).contains(profile.token!!))
                assertFalse(String(bytes, Charsets.UTF_8).contains(profile.token))
            } finally { parcel.recycle() }
            scenario.recreate()
            activity = activity(scenario)
            val restored = awaitView(activity)
            assertNotSame(original, restored)
            assertRoute(restored)
            assertEquals("\"${profile.token}\"", evaluate(restored, "window.recoveryToken"))
            instrumentation.runOnMainSync { assertEquals(profile.browserName, WebViewCompat.getProfile(restored).name) }
            assertNull(fixture.failure.get())
        }
    }

    @Test fun renameRestoresButCredentialRotationDoesNot() = withFixture { _, profile ->
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            navigate(connect(activity(scenario), profile))
            val renamed = ConnectionProfile.create("Renamed recovery profile", profile.origin, profile.token, store.vault.load().profiles.first { it.id == profile.id })
            store.vault.upsert(store.vault.load(), renamed)
            scenario.recreate()
            assertRoute(awaitView(activity(scenario)))
            val rotated = ConnectionProfile.create(renamed.name, renamed.origin, "synthetic-rotated", renamed)
            store.vault.upsert(store.vault.load(), rotated)
            scenario.recreate()
            assertConnections(activity(scenario))
        }
    }

    @Test fun deletionCannotRestoreOldGeneration() = withFixture { _, profile ->
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            navigate(connect(activity(scenario), profile))
            store.vault.remove(store.vault.load(), profile)
            scenario.recreate()
            assertConnections(activity(scenario))
        }
    }

    @Test fun originChangesCannotRestoreOldGeneration() = withFixture { _, profile ->
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            navigate(connect(activity(scenario), profile))
            val moved = ConnectionProfile.create(profile.name, "https://unreachable.invalid/", profile.token, profile)
            store.vault.upsert(store.vault.load(), moved)
            scenario.recreate()
            assertConnections(activity(scenario))
        }
    }

    @Test fun sameOriginProfilesKeepTheirOwnStorageAfterRecreation() = withFixture { _, first ->
        val second = ConnectionProfile.create("Second recovery ${UUID.randomUUID()}", first.origin, "synthetic-second")
        store.vault.upsert(store.vault.load(), second)
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                var activity = activity(scenario)
                val firstView = connect(activity, first)
                evaluate(firstView, "localStorage.setItem('recoveryIdentity','FIRST')")
                click(activity, activity.getString(R.string.connection_controls, first.name))
                val secondView = connect(activity, second)
                assertEquals("null", evaluate(secondView, "localStorage.getItem('recoveryIdentity')"))
                evaluate(secondView, "localStorage.setItem('recoveryIdentity','SECOND')")
                navigate(secondView)
                scenario.recreate()
                activity = activity(scenario)
                val restored = awaitView(activity)
                assertRoute(restored)
                assertEquals("\"SECOND\"", evaluate(restored, "localStorage.getItem('recoveryIdentity')"))
                assertEquals("\"synthetic-second\"", evaluate(restored, "window.recoveryToken"))
                click(activity, activity.getString(R.string.connection_controls, second.name))
                assertEquals("\"FIRST\"", evaluate(connect(activity, first), "localStorage.getItem('recoveryIdentity')"))
            }
        } finally { cleanProfile(second) }
    }

    @Test fun terminatedRendererRequiresRetryEvenAfterRecreation() = withFixture { _, profile ->
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var activity = activity(scenario)
            val original = connect(activity, profile)
            navigate(original)
            instrumentation.waitForIdleSync()
            instrumentation.runOnMainSync {
                assertTrue("The renderer must actually terminate", original.webViewRenderProcess!!.terminate())
            }
            await("Renderer failure did not offer Retry") { hasButton(activity, activity.getString(R.string.retry)) }
            scenario.recreate()
            activity = activity(scenario)
            assertTrue(hasButton(activity, activity.getString(R.string.retry)))
            assertNoView(activity)
            click(activity, activity.getString(R.string.retry))
            val restored = awaitView(activity)
            assertNotSame(original, restored)
            assertRoute(restored)
            assertEquals("\"${profile.token}\"", evaluate(restored, "window.recoveryToken"))
        }
    }

    @Test fun choosingConnectionsClearsRecovery() = withFixture { _, profile ->
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val activity = activity(scenario)
            navigate(connect(activity, profile))
            click(activity, activity.getString(R.string.connection_controls, profile.name))
            scenario.recreate()
            assertConnections(activity(scenario))
        }
    }

    @Test fun malformedSavedIdentityOrRouteIsRejected() {
        val profile = ConnectionProfile.create("Synthetic", "https://daemon.example/", "never-save-this-token")
        val snapshot = ConnectionRecovery(profile.id, profile.browserId, ConnectionNavigation("s", "w", "live"))
        assertEquals(snapshot, ConnectionRecovery.fromBundle(snapshot.toBundle()))
        assertNull(ConnectionRecovery.fromBundle(snapshot.toBundle().apply { putString("profile", "malformed") }))
        assertNull(ConnectionRecovery.fromBundle(snapshot.toBundle().apply { putString("browser", "malformed") }))
        assertNull(ConnectionRecovery.fromBundle(snapshot.toBundle().apply { putString("session", "s#token=secret") }))
        assertNull(ConnectionRecovery.fromBundle(snapshot.toBundle().apply { putString("workspace", "w&daemon=evil") }))
        assertNull(ConnectionRecovery.fromBundle(snapshot.toBundle().apply { putString("context", "unknown") }))
    }

    private fun withFixture(body: (Fixture, ConnectionProfile) -> Unit) {
        val supported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) && WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)
        if (InstrumentationRegistry.getArguments().getString("requireProfileIsolation") == "true") assertTrue(supported)
        assumeTrue(supported)
        Fixture().use { fixture ->
            val profile = ConnectionProfile.create("Recovery ${UUID.randomUUID()}", fixture.origin, "synthetic-recovery-${UUID.randomUUID()}")
            store.vault.upsert(store.vault.load(), profile)
            try { body(fixture, profile) } finally { cleanProfile(profile) }
        }
    }

    private fun cleanProfile(profile: ConnectionProfile) {
        try {
            val cleared = CountDownLatch(1)
            instrumentation.runOnMainSync {
                val browser = ProfileStore.getInstance().getProfile(profile.browserName)
                if (browser == null) cleared.countDown()
                else WebStorageCompat.deleteBrowsingData(browser.webStorage) { cleared.countDown() }
            }
            assertTrue(cleared.await(15, TimeUnit.SECONDS))
        } finally {
            val state = store.vault.load()
            state.profiles.find { it.id == profile.id }?.let { store.vault.remove(state, it) }
        }
    }

    private fun activity(scenario: ActivityScenario<MainActivity>): MainActivity {
        lateinit var result: MainActivity
        scenario.onActivity { result = it }
        return result
    }

    private fun connect(activity: MainActivity, profile: ConnectionProfile): WebView {
        instrumentation.runOnMainSync {
            val all = views(activity.window.decorView)
            val title = all.indexOfFirst { it is TextView && it.text.toString() == profile.name }
            assertTrue("Synthetic profile not found", title >= 0)
            assertTrue(all.drop(title + 1).filterIsInstance<Button>().first { it.text.toString().equals(activity.getString(R.string.connect), true) }.performClick())
        }
        return awaitView(activity)
    }

    private fun navigate(view: WebView) {
        evaluate(view, "history.replaceState({},'', '$route')")
        assertRoute(view)
    }

    private fun assertRoute(view: WebView) { assertEquals("\"$route\"", evaluate(view, "location.pathname+location.search")) }

    private fun awaitView(activity: MainActivity): WebView {
        var view: WebView? = null
        await("Connection did not create a WebView") {
            instrumentation.runOnMainSync { view = views(activity.window.decorView).filterIsInstance<WebView>().singleOrNull() }
            view != null
        }
        await("Loopback fixture did not load") { evaluate(view!!, "window.recoveryReady===true") == "true" }
        return view!!
    }

    private fun assertConnections(activity: MainActivity) {
        assertNoView(activity)
        assertTrue(hasButton(activity, activity.getString(R.string.add_profile)))
    }

    private fun assertNoView(activity: MainActivity) {
        instrumentation.runOnMainSync { assertTrue(views(activity.window.decorView).filterIsInstance<WebView>().isEmpty()) }
    }

    private fun hasButton(activity: MainActivity, label: String): Boolean {
        var found = false
        instrumentation.runOnMainSync { found = views(activity.window.decorView).filterIsInstance<Button>().any { it.text.toString().equals(label, true) } }
        return found
    }

    private fun click(activity: MainActivity, label: String) {
        instrumentation.runOnMainSync { assertTrue(views(activity.window.decorView).filterIsInstance<Button>().first { it.text.toString().equals(label, true) }.performClick()) }
    }

    private fun views(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { views(view.getChildAt(it)) } else emptyList()

    private fun await(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (!predicate()) {
            assertTrue(message, SystemClock.uptimeMillis() < deadline)
            SystemClock.sleep(50)
        }
    }

    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1)
        var value = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { value = it; done.countDown() } }
        assertTrue(done.await(10, TimeUnit.SECONDS))
        return value
    }

    private class Fixture : Closeable {
        private val server = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        val origin = "http://127.0.0.1:${server.localPort}/"
        val failure = AtomicReference<Throwable?>()
        @Volatile private var activeSocket: Socket? = null
        private val worker = Thread({
            try {
                while (!server.isClosed) {
                    server.accept().use { socket ->
                        activeSocket = socket
                        socket.soTimeout = 3000
                        val reader = socket.getInputStream().bufferedReader()
                        reader.readLine()
                        while (!reader.readLine().isNullOrEmpty()) { }
                        val body = """<!doctype html><body>Recovery fixture<script>
                            window.recoveryToken=new URLSearchParams(location.hash.slice(1)).get('token');
                            history.replaceState({},'',location.pathname+location.search);
                            window.recoveryReady=true;
                            </script></body>""".toByteArray()
                        socket.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            write(body)
                            flush()
                        }
                    }
                    activeSocket = null
                }
            } catch (error: Exception) { if (!server.isClosed) failure.set(error) }
        }, "connection-recovery-fixture").apply { isDaemon = true; start() }

        override fun close() {
            server.close()
            activeSocket?.close()
            worker.join(4000)
        }
    }
}
