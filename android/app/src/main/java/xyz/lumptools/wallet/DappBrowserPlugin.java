package xyz.lumptools.wallet;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.coordinatorlayout.widget.CoordinatorLayout;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * In-app browser for Midnight dApps (the Android twin of ios/App/App/DappBrowser.swift).
 *
 * The dApp page runs in its own WebView placed below the wallet's top bar. The wallet hands us the connector
 * provider script, which runs at document start in the main frame. The page talks to the wallet through an object
 * the WebView itself adds to the page; every message arrives here with the origin and the frame the WebView reports
 * for its sender (never anything the page claims) and goes to the wallet WebView as a `request` event. The wallet
 * answers through `respond`, and the answer goes back only through the reply channel of the page that asked, and
 * only while the view is still on that origin.
 *
 * The dApp view never sees the wallet's storage or keys: it has its own storage profile where the WebView supports
 * one, and it can never load the wallet's own origin (https://localhost) either way.
 */
@CapacitorPlugin(name = "DappBrowser")
public class DappBrowserPlugin extends Plugin {

    /** name of the object the page finds on `window` (src/dapp/provider.js) */
    private static final String JS_OBJECT = "lumpWalletNative";
    /** circuit keys arrive in 512 KB pieces (provider.js), so no legitimate message comes near this */
    private static final int MAX_MESSAGE_CHARS = 7 * 1024 * 1024;
    private static final String PROFILE = "dapps";
    private static final Set<String> ANY_ORIGIN = Collections.singleton("*");
    private static final Set<String> WEB_SCHEMES = new HashSet<>(Arrays.asList("https", "http", "about", "blob", "data"));
    /** schemes that are never handed to another app */
    private static final Set<String> NEVER_EXTERNAL = new HashSet<>(Arrays.asList("intent", "file", "content", "javascript", "android-app", "app"));

    private WebView web;
    private boolean loading;
    private double topCss;
    private String replyOrigin;
    private JavaScriptReplyProxy replyProxy;
    private OnBackPressedCallback back;
    private View.OnLayoutChangeListener layoutListener;

    // ---- plugin methods ----

    @PluginMethod
    public void open(PluginCall call) {
        final Uri url = httpsUrl(call.getString("url"));
        if (url == null) {
            call.reject("an https URL is required");
            return;
        }
        if (
            !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) ||
            !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        ) {
            call.reject("Update Android System WebView to use the in-app browser");
            return;
        }
        final double top = call.getDouble("top", 0.0);
        final String script = call.getString("script", "");
        bridge.executeOnMainThread(() -> {
            teardown(false);
            try {
                create(url, top, script);
                call.resolve();
            } catch (Exception e) {
                teardown(false);
                call.reject("could not open the in-app browser", e);
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            teardown(true);
            call.resolve();
        });
    }

    @PluginMethod
    public void setVisible(PluginCall call) {
        final boolean visible = call.getBoolean("visible", true);
        bridge.executeOnMainThread(() -> {
            if (web != null) web.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
            // while the wallet shows its own sheet over the page, Back belongs to the wallet
            if (back != null) back.setEnabled(visible);
            call.resolve();
        });
    }

    @PluginMethod
    public void setTop(PluginCall call) {
        final double top = call.getDouble("top", 0.0);
        bridge.executeOnMainThread(() -> {
            topCss = top;
            applyFrame();
            call.resolve();
        });
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        final Uri url = httpsUrl(call.getString("url"));
        if (url == null) {
            call.reject("an https URL is required");
            return;
        }
        bridge.executeOnMainThread(() -> {
            if (web != null) web.loadUrl(url.toString());
            call.resolve();
        });
    }

    @PluginMethod
    public void back(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            if (web != null && web.canGoBack()) web.goBack();
            call.resolve();
        });
    }

    @PluginMethod
    public void forward(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            if (web != null && web.canGoForward()) web.goForward();
            call.resolve();
        });
    }

    @PluginMethod
    public void reload(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            if (web != null) web.reload();
            call.resolve();
        });
    }

    /** Deliver the wallet's answer, but only to the page that asked, and only while the view is still on its origin. */
    @PluginMethod
    public void respond(PluginCall call) {
        final String origin = call.getString("origin");
        final String payload = call.getString("payload");
        if (origin == null || payload == null) {
            call.reject("origin and payload are required");
            return;
        }
        bridge.executeOnMainThread(() -> {
            if (web != null && replyProxy != null && origin.equals(replyOrigin) && origin.equals(originOf(web.getUrl()))) {
                try {
                    replyProxy.postMessage(payload);
                } catch (Exception ignored) {
                    // the page that asked is gone: there is nobody to answer
                }
            }
            call.resolve();
        });
    }

    // ---- the view ----

    @SuppressLint("SetJavaScriptEnabled")
    private void create(Uri url, double top, String script) {
        View wallet = bridge.getWebView();
        if (!(wallet.getParent() instanceof CoordinatorLayout)) throw new IllegalStateException("no host view");
        CoordinatorLayout host = (CoordinatorLayout) wallet.getParent();

        WebView wv = new WebView(getActivity());
        // its own cookies, storage and cache, apart from the wallet's (must be the first thing done with the view)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try {
                ProfileStore.getInstance().getOrCreateProfile(PROFILE);
                WebViewCompat.setProfile(wv, PROFILE);
            } catch (Exception ignored) {
                // the shared profile is still safe: this view cannot load the wallet's origin (see blocked())
            }
        }
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportMultipleWindows(false); // target=_blank opens in place, Back returns
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setUserAgentString(s.getUserAgentString() + " LumpWallet/1");
        wv.setBackgroundColor(Color.rgb(5, 5, 7));

        // main frame only: the same script would otherwise also run in every frame the page embeds
        WebViewCompat.addDocumentStartJavaScript(wv, "if (window === window.top) {\n" + script + "\n}", ANY_ORIGIN);
        WebViewCompat.addWebMessageListener(wv, JS_OBJECT, ANY_ORIGIN, (view, message, sourceOrigin, isMainFrame, proxy) -> {
            if (view != web || !isMainFrame) return;
            String body = message.getData();
            String origin = originOf(sourceOrigin);
            if (body == null || body.length() > MAX_MESSAGE_CHARS || origin == null) return;
            replyOrigin = origin;
            replyProxy = proxy;
            JSObject data = new JSObject();
            data.put("origin", origin);
            data.put("payload", body);
            notifyListeners("request", data);
        });
        wv.setWebViewClient(new Client());
        wv.setWebChromeClient(new Chrome());

        topCss = top;
        web = wv;
        loading = true;
        CoordinatorLayout.LayoutParams lp = new CoordinatorLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        lp.topMargin = topPx();
        lp.bottomMargin = bottomInset();
        host.addView(wv, lp);
        layoutListener = (v, l, t, r, b, ol, ot, or, ob) -> v.post(this::applyFrame);
        host.addOnLayoutChangeListener(layoutListener);

        back = new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web != null && web.canGoBack()) web.goBack();
                else teardown(true);
            }
        };
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), back);

        wv.loadUrl(url.toString());
    }

    private int topPx() {
        float density = getContext().getResources().getDisplayMetrics().density;
        return bridge.getWebView().getTop() + Math.round((float) topCss * density);
    }

    /**
     * Capacitor either keeps the whole content above the system bars and the keyboard (padding on the window), or
     * lets the wallet page draw under the bars and handle the safe area itself. In the second case this view has to
     * stay clear of the navigation bar on its own.
     */
    private int bottomInset() {
        View decor = getActivity().getWindow().getDecorView();
        if (decor.getPaddingBottom() > 0) return 0;
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
        if (insets == null) return 0;
        return insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()).bottom;
    }

    private void applyFrame() {
        if (web == null || !(web.getLayoutParams() instanceof ViewGroup.MarginLayoutParams)) return;
        ViewGroup.MarginLayoutParams lp = (ViewGroup.MarginLayoutParams) web.getLayoutParams();
        int top = topPx();
        int bottom = bottomInset();
        if (lp.topMargin == top && lp.bottomMargin == bottom) return;
        lp.topMargin = top;
        lp.bottomMargin = bottom;
        web.setLayoutParams(lp);
    }

    private void emitNav() {
        if (web == null) return;
        JSObject data = new JSObject();
        data.put("url", web.getUrl() == null ? "" : web.getUrl());
        data.put("title", web.getTitle() == null ? "" : web.getTitle());
        data.put("loading", loading);
        data.put("canGoBack", web.canGoBack());
        data.put("canGoForward", web.canGoForward());
        notifyListeners("nav", data);
    }

    private void teardown(boolean notify) {
        if (back != null) {
            back.remove();
            back = null;
        }
        replyProxy = null;
        replyOrigin = null;
        WebView wv = web;
        if (wv == null) return;
        web = null;
        ViewGroup host = (ViewGroup) wv.getParent();
        if (host != null) {
            if (layoutListener != null) host.removeOnLayoutChangeListener(layoutListener);
            host.removeView(wv);
        }
        layoutListener = null;
        try {
            wv.stopLoading();
            wv.setWebViewClient(new WebViewClient());
            wv.setWebChromeClient(null);
            wv.destroy();
        } catch (Exception ignored) {}
        if (notify) notifyListeners("closed", new JSObject());
    }

    @Override
    protected void handleOnPause() {
        if (web != null) web.onPause();
    }

    @Override
    protected void handleOnResume() {
        if (web != null) web.onResume();
    }

    @Override
    protected void handleOnDestroy() {
        teardown(false);
    }

    // ---- navigation ----

    private class Client extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.US);
            if (WEB_SCHEMES.contains(scheme)) return blocked(url);
            // mailto:, tel:, app links: hand them to the system when the user tapped one, never load them here
            if (request.isForMainFrame() && request.hasGesture() && !NEVER_EXTERNAL.contains(scheme)) {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, url);
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getActivity().startActivity(intent);
                } catch (Exception ignored) {
                    // no app for this link
                }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            if (!blocked(request.getUrl())) return null;
            return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (view != web) return;
            loading = true;
            emitNav();
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (view != web) return;
            loading = false;
            emitNav();
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            if (view == web) emitNav();
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // a view whose page process died cannot be used again
            if (view == web) teardown(true);
            return true;
        }
    }

    private class Chrome extends WebChromeClient {

        @Override
        public void onReceivedTitle(WebView view, String title) {
            if (view == web) emitNav();
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            present(url, message, false, result);
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            present(url, message, true, result);
            return true;
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, JsPromptResult result) {
            result.cancel();
            return true;
        }

        @Override
        public boolean onJsBeforeUnload(WebView view, String url, String message, JsResult result) {
            result.confirm();
            return true;
        }
    }

    private void present(String url, String message, boolean cancel, JsResult result) {
        if (getActivity() == null || getActivity().isFinishing()) {
            result.cancel();
            return;
        }
        String host = null;
        try {
            host = Uri.parse(url).getHost();
        } catch (Exception ignored) {}
        AlertDialog.Builder b = new AlertDialog.Builder(getActivity())
            .setTitle(host == null ? "" : host)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
            .setOnCancelListener((d) -> result.cancel());
        if (cancel) b.setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel());
        b.show();
    }

    // ---- helpers ----

    /** The wallet page lives on https://localhost inside this app: the dApp view must never load anything from this device itself. */
    private boolean blocked(Uri url) {
        String host = url.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.US);
        if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length() - 1);
        String own = bridge.getHost() == null ? "localhost" : bridge.getHost().toLowerCase(Locale.US);
        return (
            host.equals(own) ||
            host.equals("localhost") ||
            host.endsWith(".localhost") ||
            host.startsWith("127.") ||
            host.equals("0.0.0.0") ||
            host.equals("::1") ||
            host.equals("::")
        );
    }

    private Uri httpsUrl(String s) {
        if (s == null) return null;
        try {
            Uri u = Uri.parse(s);
            if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null || u.getHost().isEmpty() || blocked(u)) return null;
            return u;
        } catch (Exception e) {
            return null;
        }
    }

    private static String originOf(String url) {
        if (url == null) return null;
        try {
            return originOf(Uri.parse(url));
        } catch (Exception e) {
            return null;
        }
    }

    /** scheme://host[:port] of an https page; null for anything else (http, about:blank, data: pages have no say) */
    private static String originOf(Uri u) {
        if (u == null || u.getScheme() == null || u.getHost() == null) return null;
        String scheme = u.getScheme().toLowerCase(Locale.US);
        if (!scheme.equals("https")) return null;
        String host = u.getHost().toLowerCase(Locale.US);
        int port = u.getPort();
        return port == -1 || port == 443 ? scheme + "://" + host : scheme + "://" + host + ":" + port;
    }
}
