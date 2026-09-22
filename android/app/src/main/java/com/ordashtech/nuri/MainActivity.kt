package com.ordashtech.nuri

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * NURI for Android: the production web app in a WebView, plus the three things
 * a browser tab cannot do — receive push, pop it up as a heads-up
 * notification, and open the right page when it is tapped.
 *
 * The page keeps the login; the shell only hands it this phone's FCM token
 * (`nuri:fcm-token`) and tapped routes (`nuri:open-route`). The same contract
 * as the iOS shell, see private/handoff/NURI_iOS_Push_Handoff_2026-09-10.md §3.
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val origin: Uri = Uri.parse(BuildConfig.WEB_ORIGIN)

    /** The page's URL, kept for the JS bridge, which runs off the main thread. */
    @Volatile private var currentUrl: String? = null
    private var pageLoaded = false

    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingMicRequest: PermissionRequest? = null

    private val pickFiles = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        pendingFileCallback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
        pendingFileCallback = null
    }

    private val askMic = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        val request = pendingMicRequest ?: return@registerForActivityResult
        pendingMicRequest = null
        if (granted) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny()
    }

    private val askNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        PushState.markPermissionAsked(this)
        // Tell the page either way: a refusal must switch the device off server-side.
        sendTokenToPage()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        setContentView(webView)
        // Android 15 draws apps edge to edge; keep the page clear of the bars
        // and above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Voice input plays nothing, but getUserMedia needs this off.
            mediaPlaybackRequiresUserGesture = false
            userAgentString = "$userAgentString NuriAndroid/${BuildConfig.VERSION_NAME}"
        }
        webView.addJavascriptInterface(
            ShellBridge(isTrustedPage = { isTrusted(currentUrl) }, onTokenRequested = {
                runOnUiThread { sendTokenToPage() }
            }),
            "ReactNativeWebView",
        )
        webView.webViewClient = ShellWebViewClient()
        webView.webChromeClient = ShellChromeClient()

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })

        PushState.onTokenChanged = { runOnUiThread { sendTokenToPage() } }

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            // Cold start from a tapped notification opens its page directly.
            val route = RouteGuard.safe(intent?.getStringExtra(EXTRA_ROUTE))
            webView.loadUrl(BuildConfig.WEB_ORIGIN + (route ?: "/"))
        }

        askForNotificationsOnce()
        PushState.refreshToken(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val route = RouteGuard.safe(intent.getStringExtra(EXTRA_ROUTE)) ?: return
        if (pageLoaded && isTrusted(currentUrl)) {
            val detail = org.json.JSONObject().put("route", route)
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('nuri:open-route',{detail:$detail}));",
                null,
            )
        } else {
            webView.loadUrl(BuildConfig.WEB_ORIGIN + route)
        }
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // The parent may have just switched notifications off in Settings.
        if (pageLoaded) sendTokenToPage()
    }

    override fun onPause() {
        webView.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onDestroy() {
        PushState.onTokenChanged = null
        webView.destroy()
        super.onDestroy()
    }

    private fun isTrusted(url: String?): Boolean {
        val uri = url?.let(Uri::parse) ?: return false
        return uri.scheme == origin.scheme && uri.host == origin.host && uri.port == origin.port
    }

    /** Hand the page this phone's token, if there is one and the page is ours. */
    private fun sendTokenToPage() {
        if (!isTrusted(currentUrl)) return
        val script = PushState.tokenEventScript(this) ?: return
        webView.evaluateJavascript(script, null)
    }

    private fun askForNotificationsOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (!PushState.firebaseReady(this)) return
        val granted = ContextCompat.checkSelfPermission(
            this, Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted && PushState.permissionStatus(this) == "not_determined") {
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private inner class ShellWebViewClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isTrusted(request.url.toString())) return false
            // Everything else — articles, videos, tel: and mailto: — belongs
            // to the phone's own apps, never inside the shell with the bridge.
            try {
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
            } catch (_: ActivityNotFoundException) {
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            currentUrl = url
            pageLoaded = false
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // Client-side navigation in the single-page app changes the URL
            // without a new page load.
            currentUrl = url
        }

        override fun onPageFinished(view: WebView, url: String?) {
            currentUrl = url
            pageLoaded = true
            sendTokenToPage()
        }
    }

    private inner class ShellChromeClient : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val wantsMic = PermissionRequest.RESOURCE_AUDIO_CAPTURE in request.resources
            if (!wantsMic || !isTrusted(request.origin.toString())) {
                request.deny()
                return
            }
            runOnUiThread {
                val granted = ContextCompat.checkSelfPermission(
                    this@MainActivity, Manifest.permission.RECORD_AUDIO,
                ) == PackageManager.PERMISSION_GRANTED
                if (granted) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                } else {
                    pendingMicRequest?.deny()
                    pendingMicRequest = request
                    askMic.launch(Manifest.permission.RECORD_AUDIO)
                }
            }
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            pendingFileCallback?.onReceiveValue(null)
            pendingFileCallback = callback
            return try {
                pickFiles.launch(params.createIntent())
                true
            } catch (_: ActivityNotFoundException) {
                pendingFileCallback = null
                false
            }
        }
    }

    companion object {
        /** FCM puts payload data in the launch intent's extras under its own key. */
        const val EXTRA_ROUTE = "route"
    }
}
