package com.qwen.mobileshell

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MicrophoneDocumentGateDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun cancelledOpenCompletesOnceAndKeepEditingAllowsAnotherRequest() {
        Fixture().use { fixture ->
            repeat(2) { attempt ->
                fixture.launch(Intent.ACTION_OPEN_DOCUMENT)
                instrumentation.waitForIdleSync()
                fixture.scenario.onActivity { activity ->
                    assertEquals(List(attempt + 1) { Activity.RESULT_CANCELED }, fixture.results)
                    val dialog = field(activity, "activeDialog") as AlertDialog
                    assertTrue(dialog.isShowing)
                    dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick()
                    assertSame(fixture.view, field(activity, "webView"))
                    assertNotNull(fixture.view.parent)
                }
            }
        }
    }

    @Test fun cancelledSaveAndDialogBackKeepTheCurrentPage() {
        Fixture().use { fixture ->
            fixture.launch(Intent.ACTION_CREATE_DOCUMENT)
            instrumentation.waitForIdleSync()
            fixture.scenario.onActivity { activity ->
                assertEquals(listOf(Activity.RESULT_CANCELED), fixture.results)
                val dialog = field(activity, "activeDialog") as AlertDialog
                assertTrue(dialog.isShowing)
                dialog.cancel()
                assertFalse(dialog.isShowing)
                assertSame(fixture.view, field(activity, "webView"))
                assertNotNull(fixture.view.parent)
            }
        }
    }

    @Test fun staleLaunchStillCompletesButCannotPromptForANewerPage() {
        Fixture().use { fixture ->
            fixture.scenario.onActivity { activity ->
                fixture.launcher.launch(Intent(Intent.ACTION_OPEN_DOCUMENT).setType("text/plain"))
                setField(activity, "activeProfile", null)
            }
            instrumentation.waitForIdleSync()
            fixture.scenario.onActivity { activity ->
                assertEquals(listOf(Activity.RESULT_CANCELED), fixture.results)
                assertNull(field(activity, "activeDialog"))
            }
        }
    }

    private class Fixture : AutoCloseable {
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        val results = mutableListOf<Int>()
        lateinit var launcher: ActivityResultLauncher<Intent>
        lateinit var view: WebView

        init {
            scenario.onActivity { activity ->
                view = WebView(activity)
                activity.setContentView(view)
                setField(activity, "webView", view)
                setField(activity, "activeProfile", ConnectionProfile.create("Document gate test", "https://example.test", null))
                // This suite verifies ActivityResult routing; real capture is covered by the HTML acceptance harness.
                setField(activity, "microphoneAuthorized", true)
                launcher = activity.activityResultRegistry.register("microphone-document-test", ActivityResultContracts.StartActivityForResult()) {
                    results.add(it.resultCode)
                    assertNull(it.data)
                }
            }
        }

        fun launch(action: String) {
            scenario.onActivity { launcher.launch(Intent(action).setType("text/plain")) }
        }

        override fun close() {
            scenario.onActivity { launcher.unregister() }
            scenario.close()
        }
    }

    companion object {
        private fun field(activity: MainActivity, name: String): Any? =
            MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(activity)

        private fun setField(activity: MainActivity, name: String, value: Any?) {
            MainActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(activity, value)
        }
    }
}
