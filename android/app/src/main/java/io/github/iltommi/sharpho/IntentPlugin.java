package io.github.iltommi.sharpho;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "IntentLauncher")
public class IntentPlugin extends Plugin {

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url      = call.getString("url");
        String mimeType = call.getString("mimeType", "video/*");

        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(Uri.parse(url), mimeType);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app found to open this file: " + e.getMessage());
        }
    }
}
