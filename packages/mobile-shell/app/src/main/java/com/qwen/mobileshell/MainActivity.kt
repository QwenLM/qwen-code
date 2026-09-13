package com.qwen.mobileshell

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat

/**
 * Main activity: a thin WebView shell around the daemon-served Web Shell.
 *
 * Architecture per maintainer (@wenshao, issue #11704):
 * "The shape we want is: N profiles of (URL, token, display name), and switching
 *  daemons means navigating the WebView to a different origin."
 *
 * The native layer adds only what a browser genuinely cannot do:
 * 1. Keystore-backed credential storage for the daemon token.       [TODO Phase 2]
 * 2. A foreground service that keeps the SSE connection alive when
 *    the browser process is gone, and raises a native notification.  [TODO Phase 2]
 *
 * The UI stays the daemon-served Web Shell — no second native UI.
 *
 * Token delivery:
 * The daemon token is passed as `#token=<value>` in the URL fragment.
 * The Web Shell's `getDaemonToken()` reads it from `window.location.hash`
 * (never from the URL query string, so it is never sent to the server).
 * This matches the behaviour of `qwen serve --open`.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                // Allow loading mixed content only in COMPATIBILITY_MODE so that
                // sub-resources (images, fonts) can load over HTTP on LAN profiles
                // while active content (scripts, iframes) is still blocked.
                // TODO Phase 2: restrict further once LAN TLS is more widely deployed.
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
                // Required for the Web Shell's shiki/mermaid WebWorkers.
                allowContentAccess = true
            }

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val uri = request.url
                    // Let the WebView handle same-origin navigations (session deep links,
                    // SPA routing). Open external URLs in the system browser.
                    val daemonOrigin = currentDaemonUri()?.let {
                        "${it.scheme}://${it.host}${if (it.port != -1) ":${it.port}" else ""}"
                    }
                    if (daemonOrigin != null &&
                        uri.toString().startsWith(daemonOrigin)
                    ) {
                        return false // allow WebView to handle it
                    }
                    // External link — open in system browser.
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                    return true
                }
            }
        }

        setContentView(webView)

        // Back navigation: go back in WebView history first (SPA routing),
        // only exit the activity when there is no more history.
        // Uses the modern OnBackPressedCallback API (replaces deprecated onBackPressed).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // Start the foreground service to keep the SSE stream alive.
        // TODO Phase 2: only start the service once a profile is active and the
        // daemon is reachable, so we don't keep a service running for nothing.
        // Android 13+ requires POST_NOTIFICATIONS before the service's
        // notification is visible; request it with rationale in Phase 2.
        QwenForegroundService.start(this)

        // Load the daemon URL — but first check the WebView engine version.
        // The Web Shell requires Chromium 107+ (Vite's baseline-widely-available
        // target). On devices with an outdated Android System WebView the app
        // would show a blank white screen or silent layout breakage. We detect
        // the version natively here — before any web content is loaded — so that
        // even a catastrophically old engine sees a readable error message.
        if (!isWebViewVersionSufficient()) {
            showWebViewUpdateScreen()
        } else {
            loadSavedProfile()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        webView.destroy()
    }

    // -------------------------------------------------------------------------
    // Profile management (Phase 1 placeholder — Phase 2 will use Keystore)
    // -------------------------------------------------------------------------

    /**
     * Returns the currently selected daemon URI from SharedPreferences.
     *
     * Per maintainer: profiles are stored as (URL, token, display name) tuples.
     * The app mints its own stable profile key — the daemon has no stable identity
     * on the wire (`/capabilities` carries no hostname or instance id).
     *
     * Phase 2 will store the bearer token in the Android Keystore rather than
     * SharedPreferences, to protect against extraction on rooted devices.
     */
    private fun currentDaemonUri(): Uri? {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val url = prefs.getString(KEY_DAEMON_URL, null) ?: return null
        return try {
            Uri.parse(url)
        } catch (_: Exception) {
            null
        }
    }

    private fun currentDaemonToken(): String? {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        return prefs.getString(KEY_DAEMON_TOKEN, null)
    }

    /**
     * Display name of the active profile, per the (URL, token, display name)
     * tuple from the maintainer's shape. Falls back to the daemon host so the
     * UI stays readable before a name is configured.
     */
    private fun profileDisplayName(): String {
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val saved = prefs.getString(KEY_PROFILE_NAME, null)
        if (!saved.isNullOrBlank()) return saved
        return currentDaemonUri()?.host ?: "Qwen Code"
    }

    /**
     * Navigates the WebView to the saved profile, passing the bearer token
     * in the URL fragment (`#token=<value>`).
     *
     * The Web Shell reads the token from `window.location.hash` via
     * `readTokenFromLocation()` in `config/daemon.ts`. The hash is never
     * sent to the server, so the token does not appear in access logs or
     * Referer headers — this is intentional and matches `qwen serve --open`.
     *
     * If no profile is saved, the activity shows a placeholder message.
     * Phase 2 will replace this with a native profile-picker screen.
     */
    private fun loadSavedProfile() {
        val daemonUri = currentDaemonUri()
        val token = currentDaemonToken()

        if (daemonUri == null) {
            // No profile saved yet — show placeholder until the user adds one.
            // TODO Phase 2: launch a profile-picker/add-profile Activity instead.
            webView.loadData(
                """
                <html><body style="font-family:sans-serif;padding:24px;color:#888">
                <h2>No daemon profile configured</h2>
                <p>${profileDisplayName()}</p>
                <p>Phase 2 will add a profile management screen here.</p>
                <p>To test manually, configure a profile via SharedPreferences
                   (key <code>daemon_url</code> and <code>daemon_token</code>).</p>
                </body></html>
                """.trimIndent(),
                "text/html",
                "utf-8",
            )
            return
        }

        // Build the load URL: daemon root with bearer token in the fragment.
        val loadUrl = if (token != null) {
            "${daemonUri}/#token=${Uri.encode(token)}"
        } else {
            daemonUri.toString()
        }

        webView.loadUrl(loadUrl)
    }

    // -------------------------------------------------------------------------
    // WebView engine version check
    // -------------------------------------------------------------------------

    /**
     * Returns true if the installed Android System WebView is Chromium 107+,
     * the JS syntax floor required by the Web Shell (Vite's
     * baseline-widely-available build target).
     *
     * Uses [WebViewCompat.getCurrentWebViewPackage] which is safe on all API
     * levels and returns null when no WebView is available at all.
     *
     * The version string format is "107.0.5304.141" — we compare only the
     * major component.
     */
    private fun isWebViewVersionSufficient(): Boolean {
        val pkg = WebViewCompat.getCurrentWebViewPackage(this) ?: return false
        val major = pkg.versionName
            .substringBefore('.')
            .toIntOrNull()
            ?: return false
        return major >= MIN_WEBVIEW_CHROMIUM_VERSION
    }

    /**
     * Replaces the WebView with a plain-text error screen asking the user to
     * update Android System WebView. This screen is intentionally dependency-
     * free and does not rely on the Web Shell loading at all.
     */
    private fun showWebViewUpdateScreen() {
        val pkg = WebViewCompat.getCurrentWebViewPackage(this)
        val versionInfo = if (pkg != null) "version ${pkg.versionName}" else "version unknown"
        webView.loadData(
            """
            <!DOCTYPE html>
            <html lang="en">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width,initial-scale=1">
              <title>Update required</title>
              <style>
                body { font-family: sans-serif; padding: 32px 24px; color: #c9d1d9; background: #0d1117; }
                h1   { font-size: 20px; margin-bottom: 12px; }
                p    { font-size: 14px; line-height: 1.6; color: #8b949e; }
                .version { font-family: monospace; color: #f85149; }
                a    { color: #58a6ff; }
              </style>
            </head>
            <body>
              <h1>⚠ Android System WebView update required</h1>
              <p>
                Qwen Code requires <strong>Android System WebView 107</strong> or later.
                Your device is running <span class="version">$versionInfo</span>.
              </p>
              <p>
                Please update <strong>Android System WebView</strong> from
                <a href="https://play.google.com/store/apps/details?id=com.google.android.webview">
                  Google Play
                </a>
                and relaunch the app.
              </p>
              <p>
                If your device does not have Google Play, contact your device
                manufacturer or system administrator for a WebView update.
              </p>
            </body>
            </html>
            """.trimIndent(),
            "text/html",
            "utf-8",
        )
    }

    companion object {
        private const val PREFS_NAME = "qwen_profiles"
        private const val KEY_DAEMON_URL = "daemon_url"
        private const val KEY_DAEMON_TOKEN = "daemon_token"
        private const val KEY_PROFILE_NAME = "profile_name"

        /**
         * Minimum Chromium major version required by the Web Shell.
         * Matches Vite 7.3.6's `build.target = 'baseline-widely-available'`
         * which compiles to Chrome 107+ syntax.
         */
        private const val MIN_WEBVIEW_CHROMIUM_VERSION = 107
    }
}
