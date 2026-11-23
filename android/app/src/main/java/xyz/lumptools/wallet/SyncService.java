package xyz.lumptools.wallet;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Lets a sync go on after the app is left. The wallet syncs inside the app's page; Android stops an app it cannot
 * see within minutes, and puts the processor to sleep with the screen. While this service runs, with its
 * notification in the bar, neither happens. It does no work itself and holds nothing of the wallet.
 *
 * KeepAwakePlugin starts it when the app is left during a sync and ends it when the sync is done or the app is back
 * in front. It ends by itself when the app is swiped away (the page is gone then) and when Android's daily allowance
 * for this kind of service is used up.
 */
public class SyncService extends Service {

    private static final String CHANNEL = "sync";
    private static final int NOTE = 71;
    /** A sync from nothing takes about an hour; a lock that outlives anything sane is let go by the system. */
    private static final long WAKE_LIMIT_MS = 6L * 60 * 60 * 1000;

    private static SyncService live;
    /** Asked to end before Android had created it: it must still show its notification once, then it ends. */
    private static boolean endAtStart;
    private PowerManager.WakeLock wake;

    static boolean running() {
        return live != null;
    }

    /** From the main thread. False when Android does not allow it right now (the app is already out of sight). */
    static boolean begin(Context context) {
        endAtStart = false;
        if (live != null) return true;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, SyncService.class));
            return true;
        } catch (RuntimeException e) {
            return false;
        }
    }

    /** From the main thread. */
    static void end() {
        if (live != null) live.stopSelf();
        else endAtStart = true;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        live = this;
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC : 0;
            ServiceCompat.startForeground(this, NOTE, note(), type);
        } catch (RuntimeException e) {
            stopSelf();
            return;
        }
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power != null) {
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lumpwallet:sync");
            wake.setReferenceCounted(false);
            wake.acquire(WAKE_LIMIT_MS);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (endAtStart) {
            endAtStart = false;
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (live == this) live = null;
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
        super.onDestroy();
    }

    /** The app was swiped away: the page that syncs is gone. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopSelf();
    }

    /** Android 15: the day's allowance for this kind of service is used up. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        stopSelf();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification note() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null && manager.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.sync_channel), NotificationManager.IMPORTANCE_LOW);
                channel.setShowBadge(false);
                manager.createNotificationChannel(channel);
            }
        }
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.sync_note))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(tap)
            .build();
    }
}
