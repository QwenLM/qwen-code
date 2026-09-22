package com.qwen.mobileshell

import android.Manifest
import android.net.Uri
import android.webkit.PermissionRequest
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MicrophoneLifecycleDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private class AudioRequest : PermissionRequest() {
        val grants = mutableListOf<List<String>>()
        override fun getOrigin(): Uri = Uri.parse("https://example.test/")
        override fun getResources(): Array<String> = arrayOf(RESOURCE_AUDIO_CAPTURE)
        override fun grant(resources: Array<String>) { grants.add(resources.toList()) }
        override fun deny() {}
    }

    @Test fun grantedConnectionClosesWhenActivityStops() {
        instrumentation.uiAutomation.grantRuntimePermission(
            instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var view: WebView
        val request = AudioRequest()
        scenario.onActivity { activity ->
            view = attach(activity)
            // Drive the Activity's own controller so the grant callback wiring is exercised.
            val microphone = (field(activity, "microphone\$delegate") as Lazy<*>).value as NativeMicrophonePermission
            assertTrue(microphone.begin(request, "https://example.test/") { true })
            microphone.decide(request, true)
            assertEquals(1, request.grants.size)
        }
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.onActivity { activity ->
            assertNull(field(activity, "webView"))
            assertNull(view.parent)
        }
        scenario.close()
    }

    @Test fun textOnlyConnectionSurvivesActivityStop() {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var view: WebView
        scenario.onActivity { activity -> view = attach(activity) }
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.onActivity { activity ->
            assertSame(view, field(activity, "webView"))
            assertNotNull(view.parent)
        }
        scenario.close()
    }

    @Test fun reconnectAfterMicrophoneGrantStartsTextOnly() {
        instrumentation.uiAutomation.grantRuntimePermission(
            instrumentation.targetContext.packageName, Manifest.permission.RECORD_AUDIO)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        lateinit var second: WebView
        scenario.onActivity { activity ->
            attach(activity)
            val request = AudioRequest()
            val microphone = (field(activity, "microphone\$delegate") as Lazy<*>).value as NativeMicrophonePermission
            assertTrue(microphone.begin(request, "https://example.test/") { true })
            microphone.decide(request, true)
            // Reconnect tears the authorized view down; the replacement has not asked for audio.
            MainActivity::class.java.getDeclaredMethod("destroyConnection").apply { isAccessible = true }.invoke(activity)
            second = attach(activity)
        }
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.onActivity { activity -> assertSame(second, field(activity, "webView")) }
        scenario.close()
    }

    private fun attach(activity: MainActivity): WebView {
        val view = WebView(activity)
        activity.setContentView(view)
        setField(activity, "webView", view)
        setField(activity, "activeProfile", ConnectionProfile.create("Lifecycle test", "https://example.test", null))
        return view
    }

    companion object {
        private fun field(activity: MainActivity, name: String): Any? =
            MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)

        private fun setField(activity: MainActivity, name: String, value: Any?) {
            MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
        }
    }
}
