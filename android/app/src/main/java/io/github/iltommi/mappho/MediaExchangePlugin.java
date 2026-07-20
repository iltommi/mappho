package io.github.iltommi.mappho;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
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
import java.io.OutputStream;
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
    private boolean pendingEditIsMediaStore;

    // Stashed by handleOnNewIntent, consumed (and cleared) by getPendingShare.
    // A share intent can arrive before any JS listener exists to hear about
    // it (cold start — see class doc on handleOnNewIntent below), so this is
    // a pull, not just an event.
    private List<JSObject> pendingShare;

    // Unique prefix for the temp MediaStore rows writeToMediaStore creates,
    // so cleanupOrphanedTempMediaStoreFiles can find (and only find) our own.
    private static final String TEMP_NAME_PREFIX = "mappho_edittmp_";

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
            cleanupOrphanedTempMediaStoreFiles();

            boolean useMediaStore = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
            Uri uri = useMediaStore ? writeToMediaStore(bytes, mimeType) : writeToCacheFile(bytes, filename);
            if (uri == null) {
                call.reject("Could not stage photo for the external editor");
                return;
            }
            pendingEditUri = uri;
            pendingEditIsMediaStore = useMediaStore;

            Intent intent = new Intent(Intent.ACTION_EDIT);
            intent.setDataAndType(uri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            Intent chooser = Intent.createChooser(intent, "Edit photo with…");

            startActivityForResult(call, chooser, "onEditResult");
        } catch (Exception e) {
            call.reject("Failed to launch editor: " + e.getMessage());
        }
    }

    // Stages the photo as a normal MediaStore row (briefly visible under
    // Pictures/Mappho in Gallery/Photos, deleted again in onEditResult's
    // finally) instead of a private FileProvider cache file. Most gallery/
    // editor apps scope their ACTION_EDIT intent filters to content
    // providers they actually recognise (MediaStore, their own) -- a URI
    // from a third-party app's own FileProvider is invisible to them even
    // though they'd happily edit the same bytes once MediaStore knows about
    // them. No extra permission needed: apps can freely insert/delete their
    // own MediaStore rows under scoped storage (API 29+), which is also why
    // this path is gated to Q+ rather than attempted on the minSdk 24 floor.
    private Uri writeToMediaStore(byte[] bytes, String mimeType) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        String tempName = TEMP_NAME_PREFIX + System.currentTimeMillis() + ".jpg";

        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, tempName);
        values.put(MediaStore.Images.Media.MIME_TYPE, mimeType);
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Mappho");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (uri == null) return null;

        try (OutputStream os = resolver.openOutputStream(uri)) {
            if (os == null) throw new Exception("Could not open MediaStore entry for writing");
            os.write(bytes);
        }

        ContentValues done = new ContentValues();
        done.put(MediaStore.Images.Media.IS_PENDING, 0);
        resolver.update(uri, done, null, null);
        return uri;
    }

    // Pre-Q fallback: the original private-cache/FileProvider approach.
    // Lower real-world compatibility (see writeToMediaStore's comment) but
    // avoids adding a WRITE_EXTERNAL_STORAGE permission -- needed for
    // legacy storage writes below API 29 -- for the sake of API < 29 alone,
    // which this app doesn't otherwise need.
    private Uri writeToCacheFile(byte[] bytes, String filename) throws Exception {
        File dir = new File(getContext().getCacheDir(), "mappho-editshare");
        dir.mkdirs();
        File file = new File(dir, filename);
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(bytes);
        }
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
    }

    // Anything matching our temp-name prefix still in MediaStore at this
    // point is necessarily orphaned -- onEditResult always deletes its own
    // row right after use, so a leftover only happens if the process died
    // (crash, force-quit) while the external editor had focus. Swept on
    // every editExternally() call instead of needing a separate startup
    // hook wired in from JS.
    private void cleanupOrphanedTempMediaStoreFiles() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        ContentResolver resolver = getContext().getContentResolver();
        try (Cursor cursor = resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                new String[]{MediaStore.Images.Media._ID},
                MediaStore.Images.Media.DISPLAY_NAME + " LIKE ?",
                new String[]{TEMP_NAME_PREFIX + "%"}, null)) {
            if (cursor == null) return;
            int idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
            while (cursor.moveToNext()) {
                Uri uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cursor.getLong(idCol));
                resolver.delete(uri, null, null);
            }
        } catch (Exception ignored) {}
    }

    @ActivityCallback
    private void onEditResult(PluginCall call, ActivityResult result) {
        if (call == null) return;

        JSObject unchanged = new JSObject();
        unchanged.put("changed", false);

        try {
            if (result.getResultCode() != Activity.RESULT_OK) {
                // User backed out of the editor without saving.
                call.resolve(unchanged);
                return;
            }

            // Prefer the URI the editor handed back, if any; some editors
            // return a new/updated URI via the result Intent's data. Editors
            // that instead edited the file we gave them in place don't set
            // this, so fall back to re-reading our own file/MediaStore row.
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
            // Always clean up our own staged copy regardless of outcome —
            // whether the editor rewrote it in place, returned a separate
            // URI, or the user just cancelled, we don't need it anymore
            // either way, and (MediaStore case) leaving it around would
            // otherwise litter the user's real Gallery/Photos permanently.
            if (pendingEditIsMediaStore && pendingEditUri != null) {
                try { getContext().getContentResolver().delete(pendingEditUri, null, null); } catch (Exception ignored) {}
            }
            pendingEditUri = null;
            pendingEditIsMediaStore = false;
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
