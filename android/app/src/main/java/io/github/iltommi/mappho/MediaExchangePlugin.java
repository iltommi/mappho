package io.github.iltommi.mappho;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

// Two capabilities for moving photo bytes across the app boundary via
// Android's Intent system:
//   A. editExternally  — hand a photo to another installed app (Google
//      Photos, Snapseed, the stock Gallery editor, ...) via ACTION_EDIT and
//      read back whatever it leaves behind.
//   B. getPendingShare  — the reverse: Mappho registered as an ACTION_SEND
//      target, so another app (Gallery) can share photos *into* Mappho.
@CapacitorPlugin(name = "MediaExchange")
public class MediaExchangePlugin extends Plugin {

    // Set right before launching the editor, read back in the activity
    // callback — only one hand-off can be in flight at a time (the UI that
    // triggers this disables itself while a save is running), so a single
    // instance field is enough; no need to correlate by call id.
    private Uri pendingEditUri;

    // Stashed by handleOnNewIntent, consumed (and cleared) by getPendingShare.
    // A share intent can arrive before any JS listener exists to hear about
    // it (cold start — see class doc on handleOnNewIntent below), so this is
    // a pull, not just an event.
    private List<JSObject> pendingShare;

    // ── A. Hand a photo to another app for editing ─────────────────────────

    @PluginMethod
    public void editExternally(PluginCall call) {
        String base64Data = call.getString("base64Data");
        String filename = call.getString("filename", "photo.jpg");
        String mimeType = call.getString("mimeType", "image/jpeg");
        if (base64Data == null) {
            call.reject("base64Data is required");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64Data, Base64.NO_WRAP);
            File dir = new File(getContext().getCacheDir(), "mappho-editshare");
            dir.mkdirs();
            File file = new File(dir, filename);
            try (FileOutputStream fos = new FileOutputStream(file)) {
                fos.write(bytes);
            }

            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
            pendingEditUri = uri;

            Intent intent = new Intent(Intent.ACTION_EDIT);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            Intent chooser = Intent.createChooser(intent, "Edit photo with…");

            startActivityForResult(call, chooser, "onEditResult");
        } catch (Exception e) {
            call.reject("Failed to launch editor: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onEditResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject unchanged = new JSObject();
        unchanged.put("changed", false);

        if (result.getResultCode() != Activity.RESULT_OK) {
            // User backed out of the editor without saving.
            call.resolve(unchanged);
            return;
        }

        try {
            // Prefer the URI the editor handed back, if any; some editors
            // return a new/updated URI via the result Intent's data. Editors
            // that instead edited the file we gave them in place don't set
            // this, so fall back to re-reading our own file.
            Uri resultUri = (result.getData() != null) ? result.getData().getData() : null;
            if (resultUri == null) resultUri = pendingEditUri;
            if (resultUri == null) {
                call.resolve(unchanged);
                return;
            }

            byte[] editedBytes = readAllBytes(getContext().getContentResolver(), resultUri);
            JSObject ret = new JSObject();
            ret.put("changed", true);
            ret.put("base64Data", Base64.encodeToString(editedBytes, Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            // Couldn't read anything back (editor didn't cooperate, or the
            // in-place file was deleted rather than rewritten) — treat as
            // "nothing changed" rather than an error the caller has to
            // specially handle.
            call.resolve(unchanged);
        } finally {
            pendingEditUri = null;
        }
    }

    // ── B. Receive photos shared into Mappho from another app ─────────────

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

    // ── Shared helpers ──────────────────────────────────────────────────────

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
