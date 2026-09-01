package io.github.iltommi.mappho;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

// The actual APK download now goes through @capacitor/file-transfer
// (src/main.js's update-check handler) instead of Android's own
// DownloadManager — its promise only resolves on genuine completion and
// rejects on genuine failure, unlike DownloadManager's enqueue-and-forget,
// which used to leave the update check silently stuck on "downloading…"
// forever if the download failed, with no error surfaced anywhere. This
// plugin's remaining jobs are the two things FileTransfer can't do:
// checking/requesting the "install unknown apps" permission before
// bothering to download, and launching the package installer for an
// already-downloaded local file.
@CapacitorPlugin(name = "Downloader")
public class DownloadPlugin extends Plugin {

    // Android 8+ gates installing an APK from a given source app behind a
    // per-app "install unknown apps" toggle the user grants manually in
    // Settings — separate from, and not implied by, the manifest's
    // REQUEST_INSTALL_PACKAGES declaration (that only makes the permission
    // requestable, not granted). Without checking this first, installApk's
    // install intent still "succeeds" from this plugin's point of view (the
    // activity starts) but the OS silently substitutes its own "you need to
    // enable this" interstitial for the real install confirmation — which
    // from inside the app reads as the update check having done nothing
    // after a full download, forcing a second full download once the user
    // works out what happened and grants it. Checking — and sending the
    // user straight to the exact settings toggle for this app when it's
    // missing — before main.js starts the download avoids that entirely.
    @PluginMethod
    public void checkInstallPermission(PluginCall call) {
        Context ctx = getContext();
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || ctx.getPackageManager().canRequestPackageInstalls();
        if (!granted) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(settings);
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path required"); return; }

        // FileTransfer hands back a file:// URI or a plain path depending on
        // how it was called — strip the scheme if present so `new File(...)`
        // gets a plain filesystem path either way.
        String filePath = path.startsWith("file://") ? Uri.parse(path).getPath() : path;
        File apkFile = new File(filePath);
        if (!apkFile.exists()) { call.reject("file not found: " + filePath); return; }

        Context ctx = getContext();
        Uri apkUri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", apkFile);

        Intent install = new Intent(Intent.ACTION_VIEW);
        install.setDataAndType(apkUri, "application/vnd.android.package-archive");
        install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(install);

        call.resolve();
    }
}
