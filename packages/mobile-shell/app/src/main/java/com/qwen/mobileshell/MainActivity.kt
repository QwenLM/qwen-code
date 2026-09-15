package com.qwen.mobileshell

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat

/** Development shell; production profiles and per-device credentials are Phase 2. */
class MainActivity : AppCompatActivity() {
    private var webView: WebView? = null
    private var activeJsConfirm: AlertDialog? = null
    private var activeJsResult: JsResult? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Check before constructing WebView: a missing provider needs a native screen.
        val major = WebViewCompat.getCurrentWebViewPackage(this)?.versionName
            ?.substringBefore('.')?.toIntOrNull()
        if (major == null || major < 111) {
            showMessage(
                "Android System WebView update required",
                "Qwen Code requires WebView 111 or later. Update your device's WebView provider and relaunch the app.",
            )
            return
        }

        val prefs = getSharedPreferences("qwen_profiles", MODE_PRIVATE)
        val origin = prefs.getString("daemon_url", null)?.takeIf(OriginPolicy::isDaemonRoot)
        if (origin == null) {
            showMessage("No valid daemon profile", "This development build requires a saved HTTP(S) daemon origin. Profile setup will be added in Phase 2.")
            return
        }
        val token = prefs.getString("daemon_token", null)
        val loadUrl = Uri.parse(origin).buildUpon().path("/")
            .encodedFragment(token?.let { "token=${Uri.encode(it)}" }).build().toString()

        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                allowContentAccess = false
                allowFileAccess = false
                setSupportZoom(true)
                builtInZoomControls = true
                displayZoomControls = false
            }
            webChromeClient = object : WebChromeClient() {
                override fun onJsConfirm(
                    view: WebView,
                    url: String,
                    message: String,
                    result: JsResult,
                ): Boolean {
                    // WebView does not provide a confirmation UI unless the host
                    // handles this callback. Keep window.confirm() semantics for
                    // destructive Web Shell actions instead of silently returning false.
                    activeJsResult?.cancel()
                    activeJsConfirm?.dismiss()
                    activeJsResult = result
                    activeJsConfirm = AlertDialog.Builder(this@MainActivity)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok) { _, _ ->
                            activeJsResult?.confirm()
                            activeJsResult = null
                            activeJsConfirm = null
                        }
                        .setNegativeButton(android.R.string.cancel) { _, _ ->
                            activeJsResult?.cancel()
                            activeJsResult = null
                            activeJsConfirm = null
                        }
                        .setOnCancelListener {
                            activeJsResult?.cancel()
                            activeJsResult = null
                            activeJsConfirm = null
                        }
                        .create()
                        .also { it.show() }
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (OriginPolicy.isSameOrigin(origin, request.url.toString())) return false
                    if (request.isForMainFrame && OriginPolicy.isExternalLink(request.url.toString())) {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, request.url))
                        } catch (_: ActivityNotFoundException) {
                            // Some devices have no handler for a valid external link.
                        } catch (_: SecurityException) {
                            // Device policy may prevent opening another app.
                        }
                    }
                    return true
                }

                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame) showConnectionError(loadUrl)
                }

                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                    if (request.isForMainFrame) showConnectionError(loadUrl)
                }
            }
        }
        setContentView(webView!!)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.canGoBack()) {
                    if (view.parent == null) setContentView(view)
                    view.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        webView!!.loadUrl(loadUrl)
    }

    private fun showConnectionError(loadUrl: String) {
        showMessage("Cannot reach Qwen Code", "Check the daemon address, connection and certificate, then retry.") {
            webView?.let {
                setContentView(it)
                it.loadUrl(loadUrl)
            }
        }
    }

    private fun showMessage(title: String, message: String, retry: (() -> Unit)? = null) {
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val padding = (24 * resources.displayMetrics.density).toInt()
            setPadding(padding, padding, padding, padding)
            addView(TextView(context).apply { text = title; textSize = 22f })
            addView(TextView(context).apply { text = message; textSize = 16f })
            if (retry != null) addView(Button(context).apply {
                text = getString(R.string.retry)
                setOnClickListener { retry() }
            })
        })
    }

    override fun onDestroy() {
        activeJsResult?.cancel()
        activeJsResult = null
        activeJsConfirm?.setOnCancelListener(null)
        activeJsConfirm?.dismiss()
        activeJsConfirm = null
        webView?.destroy()
        webView = null
        super.onDestroy()
    }
}
