package io.github.iltommi.mappho;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
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
// plugin's only remaining job is the one thing FileTransfer can't do:
// launching the package installer for an already-downloaded local file.
@CapacitorPlugin(name = "Downloader")
public class DownloadPlugin extends Plugin {

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
