package xyz.lumptools.wallet;

import android.Manifest;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What a sync needs from the phone (src/core/awake.ts says when one is running).
 *
 * In front: the screen is held on, as on iOS. Android only honours the flag while this window is the one in front.
 *
 * Left during a sync (Home, another app, the power button): SyncService keeps the app running, and the page is
 * told it can still be seen. A page that cannot be seen gets its timers slowed to one a second, which would make
 * the sync several times slower; nothing is drawn while the app is away either way.
 *
 * Both end the moment the wallet says the sync is done.
 */
@CapacitorPlugin(name = "KeepAwake")
public class KeepAwakePlugin extends Plugin {

    private static final String PREFS = "lump.sync";
    private static final String ASKED = "askedNotifications";
    /** A sync that takes longer than this is one a person may leave: the moment to ask for the notification. */
    private static final long ASK_AFTER_MS = 12_000;
    private static final int ASK_CODE = 7101;

    private boolean syncing;
    private boolean inFront;
    private boolean kept;

    @PluginMethod
    public void set(PluginCall call) {
        final boolean on = call.getBoolean("on", false);
        bridge.executeOnMainThread(() -> {
            if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            syncing = on;
            if (!on) SyncService.end();
            else if (!inFront) background();
            else bridge.getWebView().postDelayed(this::askForNotifications, ASK_AFTER_MS);
            call.resolve();
        });
    }

    /** For the tests and for nothing else in the app: what the shell is doing for the sync right now. */
    @PluginMethod
    public void state(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            JSObject out = new JSObject();
            out.put("syncing", syncing);
            out.put("inFront", inFront);
            out.put("service", SyncService.running());
            out.put("kept", kept);
            call.resolve(out);
        });
    }

    @Override
    protected void handleOnResume() {
        inFront = true;
        kept = false;
        SyncService.end();
    }

    /** Still in front as far as Android is concerned: the last moment a service may be started. */
    @Override
    protected void handleOnPause() {
        inFront = false;
        if (syncing) background();
    }

    @Override
    protected void handleOnStop() {
        if (syncing) keepPageRunning();
    }

    private void background() {
        if (SyncService.begin(getContext())) keepPageRunning();
    }

    /** After Android has told the page it is hidden, tell it otherwise. Posted: the hidden notice arrives with the stop. */
    private void keepPageRunning() {
        final WebView page = bridge.getWebView();
        page.postDelayed(() -> {
            if (inFront || !syncing) return;
            page.onResume();
            page.resumeTimers();
            page.dispatchWindowVisibilityChanged(View.VISIBLE);
            kept = true;
        }, 700);
    }

    /** Android 13+: without this the sync still goes on in the background, only its notification is not shown. Asked once. */
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !syncing || !inFront) return;
        if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        if (prefs.getBoolean(ASKED, false)) return;
        prefs.edit().putBoolean(ASKED, true).apply();
        ActivityCompat.requestPermissions(getActivity(), new String[] { Manifest.permission.POST_NOTIFICATIONS }, ASK_CODE);
    }
}
