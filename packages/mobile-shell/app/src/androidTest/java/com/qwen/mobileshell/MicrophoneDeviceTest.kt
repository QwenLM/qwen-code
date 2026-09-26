package com.qwen.mobileshell

import android.net.Uri
import android.webkit.PermissionRequest
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MicrophoneDeviceTest {
    private class WebRequest(
        private val url: String = "https://daemon.example/",
        private val types: Array<String> = arrayOf(RESOURCE_AUDIO_CAPTURE),
    ) : PermissionRequest() {
        var denied = 0
        var grants = mutableListOf<List<String>>()
        override fun getOrigin(): Uri = Uri.parse(url)
        override fun getResources(): Array<String> = types
        override fun grant(resources: Array<String>) { grants.add(resources.toList()) }
        override fun deny() { denied++ }
    }

    private var osPermission = false
    private var launches = 0
    private var grants = 0
    private var current = true
    private val controller = NativeMicrophonePermission({ osPermission }, { launches++ }, { grants++ })
    private fun begin(request: WebRequest, origin: String = "https://daemon.example/") = controller.begin(request, origin) { current }

    @Test fun existingOsPermissionStillRequiresExplicitConsent() {
        osPermission = true
        val request = WebRequest()
        assertTrue(begin(request))
        assertEquals(0, grants)
        controller.result(true)
        assertEquals(0, grants)
        controller.decide(request, true)
        assertEquals(listOf(listOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)), request.grants)
        assertEquals(1, grants)
        assertEquals(0, launches)
    }

    @Test fun nativeDenialNeverRequestsAndroidPermission() {
        val request = WebRequest()
        assertTrue(begin(request))
        controller.decide(request, false)
        controller.cancel()
        assertEquals(1, request.denied)
        assertEquals(0, launches)
    }

    @Test fun osResultRechecksActualPermissionAndCompletesOnce() {
        val request = WebRequest()
        assertTrue(begin(request))
        controller.decide(request, true)
        assertTrue(controller.awaitingResult)
        assertEquals(1, launches)
        assertEquals(0, grants)
        controller.result(true)
        assertEquals(1, request.denied)
        controller.result(true)
        assertEquals(1, request.denied)

        val allowed = WebRequest()
        assertTrue(begin(allowed))
        controller.decide(allowed, true)
        osPermission = true
        controller.result(true)
        controller.result(true)
        assertEquals(1, allowed.grants.size)
    }

    @Test fun osDenialDoesNotGrant() {
        val request = WebRequest()
        assertTrue(begin(request))
        controller.decide(request, true)
        controller.result(false)
        assertEquals(1, request.denied)
        assertEquals(0, grants)
        assertFalse(controller.awaitingResult)
    }

    @Test fun repeatedConsentDoesNotLaunchAnotherSystemRequest() {
        val request = WebRequest()
        assertTrue(begin(request))
        controller.decide(request, true)
        controller.decide(request, true)
        assertTrue(controller.awaitingResult)
        assertEquals(1, launches)
        assertEquals(0, grants)
        osPermission = true
        controller.result(true)
        assertEquals(1, request.grants.size)
        assertFalse(controller.awaitingResult)
    }

    @Test fun wrongOriginsInsecureOriginsAndResourcesAreDenied() {
        for (request in listOf(
            WebRequest("https://other.example/"), WebRequest("https://daemon.example:444/"),
            WebRequest("http://daemon.example/"), WebRequest("https://daemon.example.evil/"),
            WebRequest(types = emptyArray()), WebRequest(types = arrayOf("future.resource")),
            WebRequest(types = arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)),
            WebRequest(types = arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE)),
        )) {
            assertFalse(begin(request))
            assertEquals(1, request.denied)
        }
        assertFalse(begin(WebRequest("http://daemon.example/"), "http://daemon.example/"))
        assertEquals(0, launches)
        for (origin in listOf("http://127.0.0.1:49441/", "http://localhost:49441/", "http://[::1]:49441/")) {
            assertTrue("Loopback origin should reach consent: $origin", begin(WebRequest(origin), origin))
            controller.cancel()
        }
    }

    @Test fun staleDocumentIsCheckedAtEntryConsentAndOsResult() {
        current = false
        assertFalse(begin(WebRequest()))
        current = true
        val beforeConsent = WebRequest()
        assertTrue(begin(beforeConsent))
        current = false
        controller.decide(beforeConsent, true)
        assertEquals(1, beforeConsent.denied)
        assertEquals(0, launches)
        current = true
        val beforeResult = WebRequest()
        assertTrue(begin(beforeResult))
        controller.decide(beforeResult, true)
        current = false
        osPermission = true
        controller.result(true)
        assertEquals(1, beforeResult.denied)
        assertEquals(0, grants)
    }

    @Test fun cancellationRetainsOldSystemResultOwnership() {
        val old = WebRequest()
        assertTrue(begin(old))
        controller.decide(old, true)
        controller.cancel()
        assertTrue(controller.awaitingResult)
        val replacement = WebRequest()
        assertFalse(begin(replacement))
        osPermission = true
        controller.result(true)
        assertEquals(1, old.denied)
        assertEquals(1, replacement.denied)
        assertEquals(0, grants)
        assertTrue(begin(WebRequest()))
    }

    @Test fun webViewCancellationDoesNotRespondAgain() {
        val request = WebRequest()
        assertTrue(begin(request))
        assertFalse(controller.cancelledByWebView(WebRequest()))
        controller.decide(request, true)
        assertTrue(controller.cancelledByWebView(request))
        controller.cancel()
        osPermission = true
        controller.result(true)
        assertEquals(0, request.denied)
        assertEquals(0, grants)
    }

    @Test fun recreatedActivityDropsOrphanResultBeforeNewConsent() {
        controller.restoreAwaitingResult(true)
        assertFalse(begin(WebRequest()))
        osPermission = true
        controller.result(true)
        assertEquals(0, grants)
        val request = WebRequest()
        assertTrue(begin(request))
        assertEquals(0, grants)
        controller.decide(request, true)
        assertEquals(1, grants)
    }

    @Test fun concurrentRequestAndStaleDecisionCannotReplaceConsent() {
        val first = WebRequest()
        val second = WebRequest()
        assertTrue(begin(first))
        assertFalse(begin(second))
        controller.decide(second, true)
        assertEquals(0, launches)
        controller.decide(first, true)
        assertEquals(1, launches)
        controller.cancel()
        assertEquals(1, first.denied)
        assertEquals(1, second.denied)
    }

    @Test fun launchFailureDeniesAndAllowsRetry() {
        val failing = NativeMicrophonePermission({ false }, { throw SecurityException() }, { fail("Unexpected grant") })
        val request = WebRequest()
        assertTrue(failing.begin(request, "https://daemon.example/") { true })
        failing.decide(request, true)
        assertEquals(1, request.denied)
        assertFalse(failing.awaitingResult)
        assertTrue(failing.begin(WebRequest(), "https://daemon.example/") { true })
    }
}
