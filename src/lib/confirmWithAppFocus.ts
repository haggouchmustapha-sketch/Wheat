function restoreAppFocus() {
  window.focus();
  void window.wheat?.windowControl?.("focus").catch(() => undefined);
}

/**
 * Native Chromium confirmation dialogs can return control before Windows has
 * restored keyboard focus to a frameless Electron window. Restore both the
 * renderer and BrowserWindow focus immediately and across the next frames.
 */
export function confirmWithAppFocus(message: string) {
  const accepted = window.confirm(message);
  restoreAppFocus();
  window.requestAnimationFrame(restoreAppFocus);
  window.setTimeout(restoreAppFocus, 100);
  return accepted;
}

export function clearTransientDocumentState() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.body.style.overflow = "";
  document.body.style.pointerEvents = "";
  document.body.removeAttribute("inert");
  document.body.removeAttribute("aria-hidden");
  restoreAppFocus();
}
