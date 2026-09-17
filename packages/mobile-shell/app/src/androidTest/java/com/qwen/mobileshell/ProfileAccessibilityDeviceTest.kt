package com.qwen.mobileshell

import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProfileAccessibilityDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private lateinit var store: AndroidProfileStore
    private lateinit var original: ProfileState
    private val alpha = ConnectionProfile.create("Accessibility Alpha", "https://alpha.example", "synthetic-token")
    private val beta = ConnectionProfile.create("Accessibility Beta", "https://beta.example", null)

    @Before fun seedProfiles() {
        store = AndroidProfileStore(context)
        original = store.vault.load()
        store.vault.save(original.copy(profiles = listOf(alpha, beta) + original.profiles))
    }

    @After fun restoreProfiles() {
        store.vault.save(original)
    }

    @Test fun profileActionsIdentifyTheirOwnConnection() {
        ActivityScenario.launch(MainActivity::class.java).use {
            for (profile in listOf(alpha, beta)) {
                for ((action, description) in listOf(
                    R.string.connect to "Connect to ${profile.name}",
                    R.string.edit to "Edit ${profile.name}",
                    R.string.delete to "Delete ${profile.name}",
                )) {
                    val node = findWithScroll { it.contentDescription?.toString() == description }
                    assertTrue(node.isClickable)
                    assertTrue(node.text.toString().equals(context.getString(action), ignoreCase = true))
                    assertFalse(node.contentDescription.toString().contains("synthetic-token"))
                }
            }
        }
    }

    @Test fun editorFieldsExposeTheirVisibleLabelsAndKeepTheTokenMasked() {
        ActivityScenario.launch(MainActivity::class.java).use {
            openFirstEditor()
            for (label in listOf(R.string.profile_name, R.string.daemon_address, R.string.daemon_token)) {
                val field = find { it.isEditable && it.hintText?.toString() == context.getString(label) }
                val related = field.labeledBy
                assertNotNull("Input must identify its visible label", related)
                assertEquals(context.getString(label), related!!.text.toString())
            }
            val secret = find { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_token) }
            assertTrue(secret.isPassword)
            assertTrue(secret.isShowingHintText)
            assertFalse(secret.text?.toString().orEmpty().contains("synthetic-token"))
        }
    }

    @Test fun validationIsPoliteAndTheUserCanCorrectTheAddress() {
        ActivityScenario.launch(MainActivity::class.java).use {
            openFirstEditor()
            val address = find { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_address) }
            setText(address, "invalid-origin")
            clickText(R.string.save)
            val error = find { it.text?.toString() == context.getString(R.string.changed_origin_credential) }
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, error.liveRegion)
            setText(find { it.isEditable && it.hintText?.toString() == context.getString(R.string.daemon_address) }, alpha.origin)
            clickText(R.string.save)
            find { it.text?.toString() == alpha.name }
            assertEquals(alpha, store.vault.load().profiles.first { it.id == alpha.id })
        }
    }

    @Test fun storageFailureHasPoliteDescription() {
        corruptVault()
        ActivityScenario.launch(MainActivity::class.java).use {
            val description = find { it.text?.toString() == context.getString(R.string.storage_unavailable_hint) }
            assertEquals(View.ACCESSIBILITY_LIVE_REGION_POLITE, description.liveRegion)
        }
    }

    @Test fun storageRecoveryIsScrollableAndResetCancellationPreservesData() {
        corruptVault()
        ActivityScenario.launch(MainActivity::class.java).use {
            find { it.className?.toString() == "android.widget.ScrollView" }
            findWithScroll { it.text?.toString()?.equals(context.getString(R.string.reset_profiles), true) == true }
                .performAction(AccessibilityNodeInfo.ACTION_CLICK)
            find { it.text?.toString() == context.getString(R.string.reset_profiles_warning) }
            clickText(android.R.string.cancel)
            assertArrayEquals(byteArrayOf(1, 2, 3), vaultFile().readBytes())
        }
    }

    private fun openFirstEditor() {
        find { it.isClickable && it.text?.toString()?.equals(context.getString(R.string.edit), true) == true }
            .performAction(AccessibilityNodeInfo.ACTION_CLICK)
    }

    private fun clickText(resource: Int) {
        assertTrue(find { it.isClickable && it.text?.toString()?.equals(context.getString(resource), true) == true }
            .performAction(AccessibilityNodeInfo.ACTION_CLICK))
    }

    private fun setText(node: AccessibilityNodeInfo, text: String) {
        assertTrue(node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }))
    }

    private fun vaultFile() = File(context.noBackupFilesDir, "connection-profiles.v1")
    private fun corruptVault() { vaultFile().writeBytes(byteArrayOf(1, 2, 3)) }

    private fun find(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        val deadline = SystemClock.uptimeMillis() + 5_000
        do {
            instrumentation.waitForIdleSync()
            val root = instrumentation.uiAutomation.rootInActiveWindow
            if (root?.packageName == context.packageName) walk(root).firstOrNull(predicate)?.let { return it }
            SystemClock.sleep(50)
        } while (SystemClock.uptimeMillis() < deadline)
        throw AssertionError("Expected native accessibility node not found")
    }

    private fun findWithScroll(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo {
        repeat(5) {
            instrumentation.waitForIdleSync()
            val root = instrumentation.uiAutomation.rootInActiveWindow
            if (root?.packageName == context.packageName) {
                walk(root).firstOrNull { it.isVisibleToUser && predicate(it) }?.let { return it }
                walk(root).firstOrNull { it.isScrollable }?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            }
            SystemClock.sleep(150)
        }
        return find { it.isVisibleToUser && predicate(it) }
    }

    private fun walk(node: AccessibilityNodeInfo): Sequence<AccessibilityNodeInfo> = sequence {
        yield(node)
        for (index in 0 until node.childCount) node.getChild(index)?.let { yieldAll(walk(it)) }
    }
}
