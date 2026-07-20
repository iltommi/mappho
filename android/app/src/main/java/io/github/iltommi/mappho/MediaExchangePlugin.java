package io.github.iltommi.mappho;

import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

// Mappho registered as an ACTION_SEND/ACTION_SEND_MULTIPLE target for
// image/*, so another app (Gallery, Files, ...) can share photos *into*
// Mappho the same way it would share to any other app. This used to also
// offer the reverse — handing a photo *out* to another app via ACTION_EDIT
// and reading back whatever it left behind — but that direction turned out
// not to be viable on a real device: neither Google Photos (its editor only
// offers "Save copy", which writes a new image elsewhere and returns
// nothing usable) nor Samsung Gallery (doesn't expose ACTION_EDIT to other
// apps at all) honored the "hand the edited file back to the calling app"
// half of the contract, regardless of whether the staged file was a private
// FileProvider cache file or a proper MediaStore row. Exporting for
// external editing now goes out via the same plain ACTION_SEND path as the
// slideshow's existing Share button (see externaledit.js), which is
// universally supported; getting the edited result back into Mappho is
// this plugin's getPendingShare/handleOnNewIntent below, same as any other
// incoming share.
@CapacitorPlugin(name = "MediaExchange")
public class MediaExchangePlugin extends Plugin {

    // Stashed by handleOnNewIntent, consumed (and cleared) by getPendingShare.
    // A share intent can arrive before any JS listener exists to hear about
    // it (cold start — see class doc on handleOnNewIntent below), so this is
    // a pull, not just an event.
    private List<JSObject> pendingShare;

    // Covers both cold start and warm resume with one override: BridgeActivity's
    // load() (called from onCreate, before the WebView has loaded any JS)
    // synthesizes a call to onNewIntent(getIntent()), and warm resume gets a
    // real onNewIntent because MainActivity is launchMode="singleTask" — so
    // this fires either way with no MainActivity.java changes needed beyond
    // registering this plugin.
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;

        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = getStreamExtra(intent);
            if (uri != null) uris.add(uri);
        } else {
            List<Uri> list = getStreamExtraList(intent);
            if (list != null) uris.addAll(list);
        }
        if (uris.isEmpty()) return;

        List<JSObject> received = new ArrayList<>();
        ContentResolver resolver = getContext().getContentResolver();
        for (Uri uri : uris) {
            try {
                byte[] bytes = readAllBytes(resolver, uri);
                JSObject item = new JSObject();
                item.put("base64Data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                item.put("filename", filenameFromUri(resolver, uri));
                item.put("mimeType", type);
                received.add(item);
            } catch (Exception ignored) {
                // Skip whatever couldn't be read; the rest of the share still goes through.
            }
        }
        if (received.isEmpty()) return;

        pendingShare = received;
        notifyListeners("shareReceived", new JSObject());
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray items = new JSArray();
        if (pendingShare != null) {
            for (JSObject item : pendingShare) items.put(item);
            pendingShare = null;
        }
        ret.put("items", items);
        call.resolve(ret);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static Uri getStreamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return getStreamExtraLegacy(intent);
    }

    @SuppressWarnings("deprecation")
    private static Uri getStreamExtraLegacy(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private static List<Uri> getStreamExtraList(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
        }
        return getStreamExtraListLegacy(intent);
    }

    @SuppressWarnings("deprecation")
    private static List<Uri> getStreamExtraListLegacy(Intent intent) {
        return intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
    }

    private static byte[] readAllBytes(ContentResolver resolver, Uri uri) throws Exception {
        try (InputStream in = resolver.openInputStream(uri)) {
            if (in == null) throw new Exception("Could not open " + uri);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static String filenameFromUri(ContentResolver resolver, Uri uri) {
        String name = null;
        try (android.database.Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (idx != -1) name = cursor.getString(idx);
            }
        } catch (Exception ignored) {}
        return (name != null && !name.isEmpty()) ? name : "shared-photo.jpg";
    }
}
