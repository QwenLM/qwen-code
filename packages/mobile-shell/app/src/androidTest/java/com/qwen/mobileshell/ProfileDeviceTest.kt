package com.qwen.mobileshell

import android.content.Context
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.File
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProfileDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val prefix = "test-${UUID.randomUUID()}."

    @Test fun realKeystoreMigrationSurvivesReopenAndRejectsKeyLoss() {
        val store = AndroidProfileStore(context, prefix)
        store.reset()
        try {
            assertTrue(context.getSharedPreferences("${prefix}qwen_profiles", Context.MODE_PRIVATE).edit()
                .putString("daemon_url", "https://example.com")
                .putString("daemon_token", "instrumentation-only-token").commit())
            val migrated = store.vault.load()
            assertEquals("instrumentation-only-token", migrated.profiles.single().token)
            val vaultFile = File(context.noBackupFilesDir, "${prefix}connection-profiles.v1")
            assertTrue(vaultFile.exists())
            assertFalse(String(vaultFile.readBytes()).contains("instrumentation-only-token"))
            assertFalse(context.getSharedPreferences("${prefix}qwen_profiles", Context.MODE_PRIVATE).contains("daemon_token"))
            assertEquals(migrated, AndroidProfileStore(context, prefix).vault.load())
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("$prefix${AndroidProfileStore.KEY_ALIAS}") }
            assertThrows(Exception::class.java) { AndroidProfileStore(context, prefix).vault.load() }
        } finally { store.reset() }
    }

    @Test fun realKeystoreRejectsTamperedSavedCredential() {
        val store = AndroidProfileStore(context, prefix)
        store.reset()
        try {
            store.vault.save(ProfileState(listOf(ConnectionProfile.create("A", "https://example.com", "synthetic"))))
            val file = File(context.noBackupFilesDir, "${prefix}connection-profiles.v1")
            val bytes = file.readBytes()
            bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
            file.writeBytes(bytes)
            assertThrows(Exception::class.java) { AndroidProfileStore(context, prefix).vault.load() }
        } finally { store.reset() }
    }

    @Test fun resetDoesNotResurrectMigratedOrInvalidLegacyCredentials() {
        val store = AndroidProfileStore(context, prefix)
        try {
            for (origin in listOf("https://example.com/", "not a daemon")) {
                val preferences = context.getSharedPreferences("${prefix}qwen_profiles", Context.MODE_PRIVATE)
                assertTrue(preferences.edit().putString("daemon_url", origin).putString("daemon_token", "synthetic").commit())
                if (origin.startsWith("https")) assertEquals(1, store.vault.load().profiles.size)
                else assertThrows(Exception::class.java) { store.vault.load() }
                store.reset()
                assertTrue(store.vault.load().profiles.isEmpty())
            }
        } finally { store.reset() }
    }

    @Test fun namedBrowserProfilesSeparateCookiesAndLocalStorageAtSameOrigin() {
        val supported = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
        if (InstrumentationRegistry.getArguments().getString("requireProfileIsolation") == "true") {
            assertTrue("This acceptance lane requires a provider with MULTI_PROFILE", supported)
        }
        assumeTrue(supported)
        val names = listOf("test-${UUID.randomUUID()}", "test-${UUID.randomUUID()}")
        val views = mutableListOf<WebView>()
        try {
            instrumentation.runOnMainSync {
                names.forEach { name ->
                    views.add(WebView(instrumentation.targetContext).apply {
                        WebViewCompat.setProfile(this, name)
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                    })
                }
            }
            for (view in views) {
                val ready = CountDownLatch(1)
                instrumentation.runOnMainSync {
                    view.webViewClient = object : android.webkit.WebViewClient() {
                        override fun onPageFinished(view: WebView, url: String) { ready.countDown() }
                    }
                    view.loadDataWithBaseURL("https://profile-test.example/", "<html><body>Profile fixture</body></html>", "text/html", "UTF-8", null)
                }
                assertTrue("Fixture did not load", ready.await(15, TimeUnit.SECONDS))
            }
            assertEquals("\"A\"", evaluate(views[0], "localStorage.setItem('workspace','A'); sessionStorage.setItem('token','A'); document.cookie='identity=A; path=/'; localStorage.getItem('workspace')"))
            assertEquals("\"A\"", evaluate(views[0], "sessionStorage.getItem('token')"))
            assertEquals("\"identity=A\"", evaluate(views[0], "document.cookie"))
            assertEquals("null", evaluate(views[1], "localStorage.getItem('workspace')"))
            assertEquals("null", evaluate(views[1], "sessionStorage.getItem('token')"))
            assertEquals("\"\"", evaluate(views[1], "document.cookie"))
            assertEquals("\"B\"", evaluate(views[1], "localStorage.setItem('workspace','B'); localStorage.getItem('workspace')"))
            assertEquals("\"A\"", evaluate(views[0], "localStorage.getItem('workspace')"))
        } finally {
            instrumentation.runOnMainSync {
                views.forEach { it.destroy() }
                names.forEach { name ->
                    try { ProfileStore.getInstance().deleteProfile(name) } catch (_: IllegalStateException) { }
                }
            }
        }
    }

    private fun evaluate(view: WebView, script: String): String {
        val done = CountDownLatch(1)
        var result = ""
        instrumentation.runOnMainSync { view.evaluateJavascript(script) { result = it; done.countDown() } }
        assertTrue("JavaScript did not finish", done.await(10, TimeUnit.SECONDS))
        return result
    }
}
