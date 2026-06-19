package io.github.iltommi.mappho;

import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "Downloader")
public class DownloadPlugin extends Plugin {

    private long pendingDownloadId = -1;
    private BroadcastReceiver downloadReceiver;

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url");
        if (url == null) { call.reject("url required"); return; }

        Context ctx = getContext();
        DownloadManager dm = (DownloadManager) ctx.getSystemService(Context.DOWNLOAD_SERVICE);

        if (pendingDownloadId != -1) { dm.remove(pendingDownloadId); pendingDownloadId = -1; }
        if (downloadReceiver != null) {
            try { ctx.unregisterReceiver(downloadReceiver); } catch (Exception ignored) {}
            downloadReceiver = null;
        }

        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setTitle("Mappho update");
        req.setDescription("Downloading…");
        req.setMimeType("application/vnd.android.package-archive");
        req.setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, "Mappho.apk");
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        pendingDownloadId = dm.enqueue(req);

        final long downloadId = pendingDownloadId;
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != downloadId) return;
                try { c.unregisterReceiver(this); } catch (Exception ignored) {}
                downloadReceiver = null;
                pendingDownloadId = -1;

                Cursor cursor = dm.query(new DownloadManager.Query().setFilterById(id));
                if (!cursor.moveToFirst()) { cursor.close(); return; }
                int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                cursor.close();

                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    Uri apkUri = dm.getUriForDownloadedFile(id);
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(apkUri, "application/vnd.android.package-archive");
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(install);
                }
            }
        };

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            ctx.registerReceiver(downloadReceiver, filter);
        }

        call.resolve();
    }
}
