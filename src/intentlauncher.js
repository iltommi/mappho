import { registerPlugin } from '@capacitor/core';

const IntentLauncher = registerPlugin('IntentLauncher');

export async function openWithIntent(url, mimeType = 'video/*') {
  return IntentLauncher.openUrl({ url, mimeType });
}
