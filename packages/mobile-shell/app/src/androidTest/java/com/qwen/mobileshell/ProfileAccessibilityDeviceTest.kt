package com.qwen.mobileshell

import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.util.AtomicFile
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * MainActivity uses the default vault. Run only on an empty test installation;
 * existing, unreadable, legacy or interrupted connection data is never replaced.
 * A production storage seam for prefixed activity fixtures is deferred.
 */
@RunWith(AndroidJUnit4::class)
class ProfileAccessibilityDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var store: AndroidProfileStore
    private val fixture = EmptyProfileFixture()
    private val alpha = ConnectionProfile.create("Accessibility Alpha", "https://alpha.example", "synthetic-token")
    private val beta = ConnectionProfile.create("Accessibility Beta", "https://beta.example", null)

    @Before fun seedProfiles() {
        assumeTrue("Refusing to overwrite an interrupted connection-vault write",
            !File(vaultFile().path + ".bak").exists() && !File(vaultFile().path + ".new").exists())
        val legacy = context.getSharedPreferences("qwen_profiles", Context.MODE_PRIVATE)
        store = AndroidProfileStore(context)
        fixture.seed(store.vault, listOf(alpha, beta), legacy.all.isNotEmpty()) {
            vaultFile().takeIf { it.exists() }?.readBytes()
        }
    }

    @After fun restoreProfiles() {
        fixture.restore { bytes ->
            val file = AtomicFile(vaultFile())
            if (bytes == null) {
                file.delete()
                assertFalse("The synthetic connection vault must be removed", file.baseFile.exists())
            } else {
                val output = file.startWrite()
                try {
                    output.write(bytes)
                    file.finishWrite(output)
                } catch (error: Exception) {
                    file.failWrite(output)
                    throw error
                }
                assertArrayEquals("The original empty vault ciphertext must be preserved", bytes, file.readFully())
            }
        }
    }

    @Test fun profileActionsIdentifyTheirOwnConnection() {
        ActivityScenario.launch(MainActivity::class.java).use {
            for (profile in listOf(alpha, beta)) {
                for ((action, description) in listOf(
                    R.string.connect to "Connect to ${profile.name}",
                    R.string.edit to "Edit ${profile.name}",
                    R.string.delete to "Delete ${profile.name}",
                )) {
                    val node = findWithScroll(description) { it.contentDescription?.toString() == description }
                    assertTrue("$description must be clickable", node.isClickable)
                    assertTrue("$description must keep its visible action label", node.text.toString().equals(context.getString(action), ignoreCase = true))
                    assertFalse("$description must not expose the saved token", node.contentDescription.toString().contains("synthetic-token"))
                }
            }
        }
    }

    @Test fun editorFieldsExposeTheirVisibleLabelsAndKeepTheTokenMasked() {
        ActivityScenario.launch(MainActivity::class.java).use {
            openFirstEditor()
            for (label in listOf(R.string.profile_name, R.string.daemon_address, R.string.daemon_token)) {
                val field = find("Editable field: ${context.getString(label)}") { it.isEditable && it.hintText?.toString() == context.getString(label) }
                val related = field.labeledBy
                assertNotNull("Input must identify its visible label", related)
                assertEquals("The field must identify ${context.getString(label)}", context.getString(label), related!!.text.toString())
            }
            val secret = find("Masked token field") { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_token) }
            assertTrue("Saved token input must be a password field", secret.isPassword)
            assertTrue("Saved token input must show its hint", secret.isShowingHintText)
            assertFalse("Saved token input must not expose its token", secret.text?.toString().orEmpty().contains("synthetic-token"))
        }
    }

    @Test fun validationIsPoliteAndTheUserCanCorrectTheAddress() {
        ActivityScenario.launch(MainActivity::class.java).use {
            it.onActivity { activity -> activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            openFirstEditor()
            val renamed = "Accessibility Alpha corrected"
            setText(find("Profile name field") { it.isEditable && it.hintText?.toString() == context.getString(R.string.profile_name) }, renamed)
            val address = find("Daemon address field") { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_address) }
            setText(address, "invalid-origin")
            clickText(R.string.save)
            val error = find("Visible changed-origin validation message") { it.isVisibleToUser && it.text?.toString() == context.getString(R.string.changed_origin_credential) }
            assertEquals("Validation must be a polite live region", View.ACCESSIBILITY_LIVE_REGION_POLITE, error.liveRegion)
            setText(find("Daemon address field after validation") { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_address) }, alpha.origin)
            clickText(R.string.save)
            find("Renamed profile in the noneditable connection list") { !it.isEditable && it.text?.toString() == renamed }
            assertEquals("Correcting the address must commit the edited profile", alpha.copy(name = renamed), store.vault.load().profiles.first { it.id == alpha.id })
        }
    }

    @Test fun storageFailureHasPoliteDescription() {
        corruptVault()
        ActivityScenario.launch(MainActivity::class.java).use {
            val description = find("Storage recovery description") { it.text?.toString() == context.getString(R.string.storage_unavailable_hint) }
            assertEquals("Storage failure must be a polite live region", View.ACCESSIBILITY_LIVE_REGION_POLITE, description.liveRegion)
        }
    }

    @Test fun storageRecoveryIsScrollableAndResetCancellationPreservesData() {
        corruptVault()
        ActivityScenario.launch(MainActivity::class.java).use {
            find("Scrollable storage recovery page") { it.className?.toString() == "android.widget.ScrollView" }
            clickText(R.string.reset_profiles)
            find("Reset confirmation warning") { it.text?.toString() == context.getString(R.string.reset_profiles_warning) }
            clickText(android.R.string.cancel)
            assertArrayEquals("Cancelling Reset must preserve the synthetic corrupt vault", byteArrayOf(1, 2, 3), vaultFile().readBytes())
        }
    }

    private fun openFirstEditor() {
        clickText(R.string.edit)
    }

    private fun clickText(resource: Int) {
        val label = context.getString(resource)
        assertTrue("Click must be accepted: $label", findWithScroll("Clickable button: $label") { it.isClickable && it.text?.toString()?.equals(label, true) == true }
            .performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }

    private fun setText(node: AccessibilityNodeInfo, text: String) {
        assertTrue("Text update must be accepted: ${node.hintText}", node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }))
    }

    private fun vaultFile() = File(context.noBackupFilesDir, "connection-profiles.v1")
    private fun corruptVault() { vaultFile().writeBytes(byteArrayOf(1, 2, 3)) }

    private fun find(what: String, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        val deadline = SystemClock.uptimeMillis() + 5_000
        do {
            instrumentation.waitForIdleSync()
            val root = instrumentation.uiAutomation.rootInActiveWindow
            if (root?.packageName == context.packageName) walk(root).firstOrNull(predicate)?.let { return it }
            SystemClock.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("Expected native accessibility node not found: $what")
    }

    private fun findWithScroll(what: String, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        repeat(5) {
            instrumentation.waitForIdleSync()
            val root = instrumentation.uiAutomation.rootInActiveWindow
            if (root?.packageName == context.packageName) {
                walk(root).firstOrNull { it.isVisibleToUser && predicate(it) }?.let { return it }
                walk(root).firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            }
            SystemClock.sleep(150)
        }
        return find(what) { it.isVisibleToUser && predicate(it) }
    }

    private fun walk(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        yield(node)
        for (index in 0 until node.childCount) node.getChild(index)?.let { yieldAll(walk(it)) }
    }
}
