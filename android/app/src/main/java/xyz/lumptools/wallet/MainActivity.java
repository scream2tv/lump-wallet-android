package xyz.lumptools.wallet;

import android.content.res.Configuration;
import android.os.Bundle;
import android.view.Window;
import androidx.appcompat.app.AppCompatDelegate;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // The wallet is dark only, whatever the phone's theme is. Set before the activity gets its context, so that
    // everything that asks "is it night?" (the system bar icons, the page's colour scheme) gets the same answer.
    static {
        AppCompatDelegate.setDefaultNightMode(AppCompatDelegate.MODE_NIGHT_YES);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppShellPlugin.class);
        registerPlugin(DappBrowserPlugin.class);
        registerPlugin(KeepAwakePlugin.class);
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
        lightBarIcons();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        lightBarIcons();
    }

    /** Light icons on the dark status and navigation bars; posted, so it lands after anything that sets them by theme. */
    private void lightBarIcons() {
        final Window window = getWindow();
        window
            .getDecorView()
            .post(() -> {
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
                bars.setAppearanceLightStatusBars(false);
                bars.setAppearanceLightNavigationBars(false);
            });
    }
}
