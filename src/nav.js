// Central back-navigation stack. Every full-screen view/overlay pushes an
// entry when it opens (viewOpened) and pops it from its own close path
// (viewClosed) — whatever triggered the close — so the stack always mirrors
// what's on screen. The top entry is the visible view; entries below it are
// parents, possibly hidden, waiting to be restored when their child closes.

const stack = [];

// `close()` must hide the view and end by calling viewClosed(name); it may
// instead consume the back-press internally (e.g. step up one folder level)
// and leave the entry in place. `restore()` re-shows a parent that hid
// itself while a child was open; views that stay visible underneath their
// children (e.g. the grid under the slideshow) omit it.
export function viewOpened(name, { close, restore = null }) {
  const i = stack.findIndex(e => e.name === name);
  if (i !== -1) stack.splice(i, 1);
  stack.push({ name, close, restore });
}

// `restoreParent: false` means the view is handing the screen to something
// that isn't its parent (map handoff, a scheduled reopen) — the parent stays
// in the stack but isn't re-shown now.
export function viewClosed(name, { restoreParent = true } = {}) {
  const i = stack.findIndex(e => e.name === name);
  if (i === -1) return;
  const wasTop = i === stack.length - 1;
  stack.splice(i, 1);
  if (wasTop && restoreParent) stack[stack.length - 1]?.restore?.();
}

// Re-shows the top entry's view, if any. For the end of a flow that took
// over the screen (e.g. a bulk geotag run on the map) and finished without
// opening another view — whatever parent is still stacked gets the screen back.
export function restoreTop() {
  stack[stack.length - 1]?.restore?.();
}

// Hardware/system back: close (or delegate to) the top view. Returns false
// when nothing is open, so the caller can minimize the app instead.
export function navBack() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}
