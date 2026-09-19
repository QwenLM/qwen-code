package com.qwen.mobileshell

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.text.method.PasswordTransformationMethod
import android.view.View
import android.view.ViewGroup
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.ProfileStore
import androidx.webkit.WebStorageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {
    private var store: AndroidProfileStore? = null
    private var state = ProfileState()
    private var webView: WebView? = null
    private var activeProfile: ConnectionProfile? = null
    private var activeDialog: AlertDialog? = null
    private var activeJsResult: JsResult? = null
    private var connectionAttempt = 0
    private var microphoneDialog: AlertDialog? = null
    private var microphoneAuthorized = false
    private val microphone: NativeMicrophonePermission by lazy {
        NativeMicrophonePermission(
            { ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED },
            { microphoneLauncher.launch(Manifest.permission.RECORD_AUDIO) },
            { microphoneAuthorized = true },
        )
    }
    private val microphoneLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        microphone.result(it)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        microphone.restoreAwaitingResult(savedInstanceState?.getBoolean("microphone-in-flight") ?: false)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val view = webView
                if (view != null && view.parent != null && view.canGoBack()) view.goBack()
                else if (activeProfile != null) showProfiles()
                else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
        loadProfiles()
    }

    private fun loadProfiles() {
        try {
            val storage = store ?: AndroidProfileStore(this).also { store = it }
            state = storage.vault.load()
            retireBrowserProfiles()
            showProfiles()
        } catch (_: Exception) { showStorageError() }
    }

    private fun retireBrowserProfiles() {
        if (WebViewCompat.getCurrentWebViewPackage(this) == null) return
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val profiles = ProfileStore.getInstance()
        val live = state.profiles.map { it.browserName }.toSet()
        val retired = profiles.allProfileNames.filter { it.startsWith("qwen-") && it !in live }
        val pending = state.retiredBrowsers.toMutableSet()
        for (name in retired + pending.toList()) {
            try {
                profiles.deleteProfile(name)
                pending.remove(name)
            } catch (_: IllegalStateException) { pending.add(name) }
        }
        if (pending != state.retiredBrowsers) {
            val next = state.copy(retiredBrowsers = pending)
            store!!.vault.save(next)
            state = next
        }
    }

    private fun column(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        val padding = (20 * resources.displayMetrics.density).toInt()
        setPadding(padding, padding, padding, padding)
    }

    private fun LinearLayout.label(value: String, heading: Boolean = false) {
        addView(TextView(context).apply { text = value; textSize = if (heading) 22f else 16f })
    }

    private fun LinearLayout.button(value: String, action: () -> Unit) {
        addView(Button(context).apply { text = value; setOnClickListener { action() } })
    }

    private fun showProfiles() {
        destroyConnection()
        val content = column().apply {
            label(getString(R.string.connections), true)
            label(getString(R.string.development_notice))
            if (state.profiles.isEmpty()) label(getString(R.string.no_profiles))
            for (profile in state.profiles) {
                label(profile.name, true)
                label(profile.origin)
                button(getString(R.string.connect)) { connect(profile) }
                button(getString(R.string.edit)) { editProfile(profile) }
                button(getString(R.string.delete)) {
                    activeDialog = AlertDialog.Builder(this@MainActivity)
                        .setTitle(R.string.delete_profile)
                        .setMessage(getString(R.string.delete_profile_message, profile.name))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(R.string.delete) { _, _ ->
                            try {
                                state = store!!.vault.remove(state, profile)
                                showProfiles()
                            } catch (_: Exception) { showStorageError() }
                        }.show()
                }
            }
            button(getString(R.string.add_profile)) { editProfile(null) }
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private fun editProfile(previous: ConnectionProfile?) {
        val form = column().apply { importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS }
        fun field(label: Int, value: String, type: Int): EditText {
            form.label(getString(label))
            return EditText(this).apply {
                hint = getString(label)
                setText(value)
                isSingleLine = true
                inputType = type
                if (label == R.string.daemon_token) transformationMethod = PasswordTransformationMethod.getInstance()
                isSaveEnabled = false
                form.addView(this)
            }
        }
        val name = field(R.string.profile_name, previous?.name.orEmpty(), InputType.TYPE_CLASS_TEXT)
        val address = field(R.string.daemon_address, previous?.origin.orEmpty(), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val token = field(R.string.daemon_token, "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        val keep = CheckBox(this).apply {
            text = getString(R.string.keep_credential)
            isChecked = previous?.token != null
            visibility = if (previous?.token != null) View.VISIBLE else View.GONE
            form.addView(this)
        }
        form.label(getString(R.string.credential_hint))
        val error = TextView(this).also { form.addView(it) }
        val dialog = AlertDialog.Builder(this)
            .setTitle(if (previous == null) R.string.add_profile else R.string.edit_profile)
            .setView(ScrollView(this).apply { addView(form) })
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.save, null)
            .create()
        activeDialog = dialog
        dialog.setOnDismissListener { token.text.clear() }
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                try {
                    val typed = token.text.toString()
                    val sameOrigin = OriginPolicy.canonicalRoot(address.text.toString().trim()) == previous?.origin
                    require(!(typed.isEmpty() && keep.isChecked && !sameOrigin)) { getString(R.string.changed_origin_credential) }
                    val credential = if (typed.isNotEmpty()) typed else if (keep.isChecked && sameOrigin) previous?.token else null
                    val profile = ConnectionProfile.create(name.text.toString(), address.text.toString(), credential, previous)
                    state = store!!.vault.upsert(state, profile)
                    dialog.dismiss()
                    showProfiles()
                } catch (invalid: IllegalArgumentException) { error.text = invalid.message }
                catch (_: Exception) { error.setText(R.string.save_failed) }
            }
        }
        dialog.show()
    }

    private fun connect(profile: ConnectionProfile) {
        destroyConnection()
        try { state = store!!.vault.load() }
        catch (_: Exception) { showStorageError(); return }
        val current = state.profiles.find { it.id == profile.id && it.browserId == profile.browserId }
            ?: return showProfiles()
        val major = WebViewCompat.getCurrentWebViewPackage(this)?.versionName?.substringBefore('.')?.toIntOrNull()
        if (major == null || major < 111) {
            showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            return
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                val profiles = ProfileStore.getInstance()
                if (BrowserProfilePreparation.isPending(current.browserName)) {
                    activeProfile = current
                    showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint)) { connect(current) }
                    return
                }
                if (!current.needsBrowserInitialization(profiles.allProfileNames)) {
                    openConnection(current)
                    return
                }
                state = store!!.vault.setBrowserInitialized(state, current, false)
                if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
                    activeProfile = current
                    if (!BrowserProfilePreparation.reserve(current.browserName)) {
                        showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint)) { connect(current) }
                        return
                    }
                    val attempt = connectionAttempt
                    showMessage(getString(R.string.preparing_browser), getString(R.string.preparing_browser_hint))
                    try {
                        WebStorageCompat.deleteBrowsingData(profiles.getOrCreateProfile(current.browserName).webStorage) {
                            BrowserProfilePreparation.release(current.browserName)
                            if (attempt != connectionAttempt || isDestroyed || isFinishing) return@deleteBrowsingData
                            try {
                                state = store!!.vault.load()
                                if (state.profiles.none { it.id == current.id && it.browserId == current.browserId }) {
                                    showProfiles()
                                    return@deleteBrowsingData
                                }
                                state = store!!.vault.setBrowserInitialized(state, current, true)
                                openConnection(state.profiles.first { it.id == current.id && it.browserId == current.browserId })
                            } catch (_: Exception) { showStorageError() }
                        }
                    } catch (_: Exception) {
                        BrowserProfilePreparation.release(current.browserName)
                        showMessage(getString(R.string.browser_preparation_failed), getString(R.string.preparing_browser_hint)) { connect(current) }
                    }
                } else showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            } catch (_: Exception) { showStorageError() }
        } else showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun openConnection(profile: ConnectionProfile) {
        val view = WebView(this)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            WebViewCompat.setProfile(view, profile.browserName)
        } else {
            view.destroy()
            showMessage(getString(R.string.provider_update), getString(R.string.provider_requirement))
            return
        }
        val loadUrl = Uri.parse(profile.origin).buildUpon()
            .encodedFragment(profile.token?.let { "token=${Uri.encode(it)}" }).build().toString()
        webView = view
        activeProfile = profile
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowContentAccess = false
            allowFileAccess = false
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                if (!microphone.begin(request, profile.origin) {
                    !isFinishing && !isDestroyed && lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                        view === webView && view.parent != null && OriginPolicy.isSameOrigin(profile.origin, view.url.orEmpty())
                }) return
                cancelDialog()
                microphoneDialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle(R.string.microphone_title)
                    .setMessage(getString(R.string.microphone_consent, profile.origin))
                    .setPositiveButton(R.string.microphone_allow) { _, _ ->
                        microphoneDialog = null
                        microphone.decide(request, true)
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancelMicrophone() }
                    .setOnCancelListener { cancelMicrophone() }.show()
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (microphone.cancelledByWebView(request)) dismissMicrophoneDialog()
            }

            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                if (view !== webView || !OriginPolicy.isSameOrigin(profile.origin, url)) {
                    result.cancel()
                    return true
                }
                cancelDialog()
                activeJsResult = result
                activeDialog = AlertDialog.Builder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ ->
                        if (view === webView) activeJsResult?.confirm() else activeJsResult?.cancel()
                        activeJsResult = null
                        activeDialog = null
                    }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> cancelDialog() }
                    .setOnCancelListener { cancelDialog() }.show()
                return true
            }
        }
        view.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                if (view === webView) cancelMicrophone()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (view !== webView) return true
                if (OriginPolicy.isSameOrigin(profile.origin, request.url.toString())) return false
                if (request.isForMainFrame && OriginPolicy.isExternalLink(request.url.toString())) {
                    try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                    catch (_: ActivityNotFoundException) { }
                    catch (_: SecurityException) { }
                }
                return true
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (view === webView && request.isForMainFrame) showConnectionError(view, profile)
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
                if (view === webView && request.isForMainFrame) showConnectionError(view, profile)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view === webView) {
                    destroyConnection()
                    showMessage(getString(R.string.renderer_stopped), getString(R.string.retry_connection)) { connect(profile) }
                }
                return true
            }
        }
        showWebView(view, profile)
        view.loadUrl(loadUrl)
    }

    private fun showWebView(view: WebView, profile: ConnectionProfile) {
        (view.parent as? ViewGroup)?.removeView(view)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            button(getString(R.string.connection_controls, profile.name)) { showProfiles() }
            addView(view, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    private fun showConnectionError(view: WebView, profile: ConnectionProfile) {
        cancelMicrophone()
        if (microphoneAuthorized) {
            destroyConnection()
            showMessage(getString(R.string.connection_failed), getString(R.string.connection_failed_hint)) { connect(profile) }
            return
        }
        cancelDialog()
        (view.parent as? ViewGroup)?.removeView(view)
        showMessage(getString(R.string.connection_failed), getString(R.string.connection_failed_hint)) {
            if (view === webView) connect(profile)
        }
    }

    private fun showMessage(title: String, message: String, retry: (() -> Unit)? = null) {
        setContentView(ScrollView(this).apply {
            addView(column().apply {
                label(title, true)
                label(message)
                if (retry != null) button(getString(R.string.retry), retry)
                button(getString(R.string.connections)) { showProfiles() }
            })
        })
    }

    private fun showStorageError() {
        destroyConnection()
        setContentView(column().apply {
            label(getString(R.string.storage_unavailable), true)
            label(getString(R.string.storage_unavailable_hint))
            button(getString(R.string.retry)) { loadProfiles() }
            button(getString(R.string.reset_profiles)) {
                activeDialog = AlertDialog.Builder(this@MainActivity)
                    .setTitle(R.string.reset_profiles)
                    .setMessage(R.string.reset_profiles_warning)
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(R.string.reset_profiles) { _, _ ->
                        try {
                            val storage = store ?: AndroidProfileStore(this@MainActivity).also { store = it }
                            storage.reset()
                            loadProfiles()
                        } catch (_: Exception) { showStorageError() }
                    }.show()
            }
        })
    }

    private fun cancelDialog() {
        activeJsResult?.cancel()
        activeJsResult = null
        val dialog = activeDialog
        activeDialog = null
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
    }

    private fun destroyConnection() {
        connectionAttempt++
        cancelMicrophone()
        microphoneAuthorized = false
        cancelDialog()
        val previous = webView
        webView = null
        activeProfile = null
        (previous?.parent as? ViewGroup)?.removeView(previous)
        previous?.stopLoading()
        previous?.destroy()
    }

    override fun onDestroy() {
        destroyConnection()
        super.onDestroy()
    }

    private fun dismissMicrophoneDialog() {
        val dialog = microphoneDialog
        microphoneDialog = null
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
    }

    private fun cancelMicrophone() {
        microphone.cancel()
        dismissMicrophoneDialog()
    }

    @Suppress("DEPRECATION")
    override fun startActivityForResult(intent: Intent, requestCode: Int, options: Bundle?) {
        val view = webView
        val profile = activeProfile
        if (microphoneAuthorized && view != null && profile != null &&
            intent.action in listOf(Intent.ACTION_OPEN_DOCUMENT, Intent.ACTION_CREATE_DOCUMENT)) {
            // Finish the launcher's request after it has returned, without opening a doomed picker.
            window.decorView.post {
                onActivityResult(requestCode, Activity.RESULT_CANCELED, null)
                if (view !== webView || profile !== activeProfile || isFinishing || isDestroyed) return@post
                cancelMicrophone()
                cancelDialog()
                activeDialog = AlertDialog.Builder(this)
                    .setTitle(R.string.microphone_files_title)
                    .setMessage(R.string.microphone_files_reconnect)
                    .setNegativeButton(R.string.keep_editing, null)
                    .setPositiveButton(R.string.reconnect) { _, _ ->
                        if (view === webView && profile === activeProfile) connect(profile)
                    }.show()
            }
            return
        }
        super.startActivityForResult(intent, requestCode, options)
    }

    override fun onStop() {
        cancelMicrophone()
        val profile = activeProfile
        if (microphoneAuthorized && profile != null) {
            destroyConnection()
            showMessage(getString(R.string.microphone_closed), getString(R.string.microphone_reconnect)) { connect(profile) }
        }
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("microphone-in-flight", microphone.awaitingResult)
        super.onSaveInstanceState(outState)
    }
}
