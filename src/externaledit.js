import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { downloadFullFile, bufToBase64 } from './pcloud.js';
import { removeMarker } from './map.js';
import { deleteRecord, deleteOrphan } from './db.js';
import { isVideo } from './mp4.js';
import { log } from './log.js';

// Exports the full-resolution original via the OS share sheet — the same
// Share.share()/@capacitor/share mechanism the slideshow's own Share button
// already uses successfully for photos, just downloading the real file
// instead of a resized thumbnail. Not an automatic edit-and-return round
// trip: ACTION_EDIT's "hand the edited file back to the calling app"
// contract turned out not to be honored on a real device by either Google
// Photos (its editor only offers "Save copy", which writes a new image
// elsewhere and returns nothing usable) or Samsung Gallery (doesn't expose
// ACTION_EDIT to other apps at all, despite having its own editor). Sharing
// out via ACTION_SEND is, by contrast, universally supported — the user
// edits and saves in whichever app they pick, then shares the result back
// into Mappho via the existing share-import feature (import.js).
export async function exportForExternalEdit(photo, onDone) {
  if (isVideo(photo.name) || /\.heic$/i.test(photo.name)) {
    onDone?.({ success: false, unsupported: true });
    return;
  }

  const { fileid, name } = photo;
  let buf;
  try {
    buf = await downloadFullFile(fileid);
  } catch (e) {
    if (e.pcloudResult === 2009) {
      removeMarker(fileid);
      await Promise.all([deleteRecord(fileid), deleteOrphan(fileid)]).catch(() => {});
      log('externaledit', `Purged stale record — fileid ${fileid} no longer exists on pCloud`);
      onDone?.({ success: false, stale: true });
      return;
    }
    log('externaledit', `download failed: ${e.message}`);
    onDone?.({ success: false, error: e.message });
    return;
  }

  const tmpName = name.replace(/\.heic$/i, '.jpg');
  let written;
  try {
    written = await Filesystem.writeFile({ path: tmpName, data: bufToBase64(buf), directory: Directory.Cache });
    await Share.share({ files: [written.uri], dialogTitle: 'Edit with…' });
    onDone?.({ success: true });
  } catch (e) {
    if (e.name === 'AbortError') { onDone?.({ success: false, cancelled: true }); return; }
    log('externaledit', `share failed: ${e.message}`);
    onDone?.({ success: false, error: e.message });
  } finally {
    if (written) Filesystem.deleteFile({ path: tmpName, directory: Directory.Cache }).catch(() => {});
  }
}
