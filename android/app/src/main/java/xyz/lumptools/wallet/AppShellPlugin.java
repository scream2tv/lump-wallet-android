package xyz.lumptools.wallet;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * What the wallet page needs from Android itself (src/ui/back.ts).
 * The system Back button: the wallet is one page with its own screens, so Back is the page's call. It gets a
 * `lumpback` event and either goes one screen back or asks us to put the app in the background. Until the page
 * says it is listening, Back just backgrounds the app.
 * The clipboard, for the wallet's Paste buttons, and the share sheet, for Receive → Share.
 * The installed build's number and a way to open the download page, for the "update available" prompt.
 */
@CapacitorPlugin(name = "AppShell")
public class AppShellPlugin extends Plugin {

    private boolean pageReady = false;

    @Override
    public void load() {
        getActivity()
            .getOnBackPressedDispatcher()
            .addCallback(
                getActivity(),
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        if (pageReady) bridge.triggerWindowJSEvent("lumpback");
                        else getActivity().moveTaskToBack(true);
                    }
                }
            );
    }

    @PluginMethod
    public void ready(PluginCall call) {
        pageReady = true;
        call.resolve();
    }

    @PluginMethod
    public void minimize(PluginCall call) {
        getActivity().moveTaskToBack(true);
        call.resolve();
    }

    /** Which build of the app is installed (src/core/update.ts compares it with the one we hand out). */
    @PluginMethod
    public void info(PluginCall call) {
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("version", p.versionName == null ? "" : p.versionName);
            result.put("code", PackageInfoCompat.getLongVersionCode(p));
            call.resolve(result);
        } catch (Exception e) {
            call.reject("the installed build could not be read");
        }
    }

    /** A web address in the phone's own browser (the download page of a newer build). https only. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) {
            call.reject("an https address is required");
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        view.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            getActivity().startActivity(view);
            call.resolve();
        } catch (Exception e) {
            call.reject("nothing on this phone can open a web address");
        }
    }

    /** The system share sheet with a piece of text (Receive → Share: the address). */
    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty()) {
            call.reject("text is required");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        try {
            getActivity().startActivity(Intent.createChooser(send, null));
            call.resolve();
        } catch (Exception e) {
            call.reject("nothing on this phone can share text");
        }
    }

    /** The text on the clipboard, for the wallet's own Paste buttons (the WebView cannot read it by itself). */
    @PluginMethod
    public void readClipboard(PluginCall call) {
        bridge.executeOnMainThread(() -> {
            String text = "";
            try {
                ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
                ClipData clip = cm == null ? null : cm.getPrimaryClip();
                if (clip != null && clip.getItemCount() > 0) {
                    CharSequence s = clip.getItemAt(0).coerceToText(getContext());
                    if (s != null) text = s.toString();
                }
            } catch (Exception ignored) {
                // nothing readable on the clipboard
            }
            JSObject result = new JSObject();
            result.put("text", text);
            call.resolve(result);
        });
    }
}
