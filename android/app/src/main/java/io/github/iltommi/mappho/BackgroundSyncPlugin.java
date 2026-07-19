package io.github.iltommi.mappho;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// Thin bridge to BackgroundSyncService — see that class for what it's for.
// start() and update() are the same underlying call (a foreground service's
// notification can be replaced just by starting it again with new extras);
// kept as two JS-facing methods only because "update" reads clearer at the
// call site than "start again with new text".
@CapacitorPlugin(
    name = "BackgroundSync",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class BackgroundSyncPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        // Denied/never-asked only hides the notification itself — Android still
        // lets the foreground service (and the process it keeps alive) start
        // without it, so this is a courtesy prompt, not a gate.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "startOrUpdate");
            return;
        }
        startOrUpdate(call);
    }

    @PluginMethod
    public void update(PluginCall call) {
        startOrUpdate(call);
    }

    @PermissionCallback
    private void startOrUpdate(PluginCall call) {
        Context ctx = getContext();
        Intent intent = new Intent(ctx, BackgroundSyncService.class);
        intent.putExtra(BackgroundSyncService.EXTRA_TITLE, call.getString("title", "Mappho"));
        intent.putExtra(BackgroundSyncService.EXTRA_BODY, call.getString("body", "Syncing photos…"));
        ContextCompat.startForegroundService(ctx, intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), BackgroundSyncService.class));
        call.resolve();
    }
}
