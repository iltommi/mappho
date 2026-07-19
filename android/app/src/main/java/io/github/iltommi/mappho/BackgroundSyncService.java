package io.github.iltommi.mappho;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;

// Keeps the app process (and its WebView JS) alive while backgrounded for a
// long-running photo sync — bulk geotag/fix-date/edit — that would otherwise
// get throttled or killed once Mappho loses focus. Started/stopped/updated
// from BackgroundSyncPlugin, which is the only thing that talks to this.
public class BackgroundSyncService extends Service {
    public static final String CHANNEL_ID = "mappho_sync";
    public static final int NOTIFICATION_ID = 4242;

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_BODY = "body";

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Photo sync", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while a bulk photo operation keeps running in the background");
            nm.createNotificationChannel(channel);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
        String body  = intent != null ? intent.getStringExtra(EXTRA_BODY)  : null;
        Notification notification = buildNotification(
            title != null ? title : "Mappho", body != null ? body : "Syncing photos…");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification(String title, String body) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(body)
            .setSmallIcon(R.drawable.ic_stat_sync)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
