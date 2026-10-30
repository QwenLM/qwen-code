package com.qwen.mobileshell

import android.security.NetworkSecurityPolicy
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.URI
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkSecurityDeviceTest {
    private val policy = NetworkSecurityPolicy.getInstance()

    @Test fun ipv6LoopbackUrlAllowsCleartext() {
        val host = URI("http://[::1]:4170/").host
        assertTrue("IPv6 loopback URL host must allow cleartext: $host", policy.isCleartextTrafficPermitted(host))
    }

    @Test fun existingLoopbackHostsStillAllowCleartext() {
        for (host in listOf("localhost", "127.0.0.1", "::1")) {
            assertTrue("Loopback must allow cleartext: $host", policy.isCleartextTrafficPermitted(host))
        }
    }

    @Test fun otherHostsStillRejectCleartext() {
        for (host in listOf(
            "example.com", "192.168.1.2", "10.0.0.2", "sub.localhost", "localhost.example.com",
            "::2", "[::2]", "[2001:db8::1]", "[::ffff:127.0.0.1]",
        )) {
            assertFalse("Non-allowlisted host must reject cleartext: $host", policy.isCleartextTrafficPermitted(host))
        }
    }
}
