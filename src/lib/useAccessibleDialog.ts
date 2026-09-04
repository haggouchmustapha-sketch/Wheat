import { useEffect, useRef, type RefObject } from "react";

const focusableSelector = [
  "[autofocus]",
  "[data-autofocus]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

let dialogStack: HTMLElement[] = [];
let bodyOverflowBeforeDialogs = "";

/**
 * Clears focus-containment state during destructive workspace transitions.
 * React will still run each dialog's normal effect cleanup when it unmounts.
 */
export function resetAccessibleDialogState() {
  dialogStack = [];
  bodyOverflowBeforeDialogs = "";
  document.body.style.overflow = "";
}

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) => (
    !element.hasAttribute("hidden")
    && element.getAttribute("aria-hidden") !== "true"
    && element.getClientRects().length > 0
  ));
}

/**
 * A Wheat combobox renders its option panel through a portal on `<body>`, so
 * the panel sits outside the dialog element while being logically part of it.
 * Focus containment has to recognise that, otherwise the panel's integrated
 * search bar is pulled back to the dialog on its first keystroke and can never
 * be typed into.
 */
function isInsideDialogSurface(dialog: HTMLElement, node: Node | null) {
  if (!node) return false;
  if (dialog.contains(node)) return true;
  const element = node instanceof Element ? node : node.parentElement;
  return Boolean(element?.closest("[data-wheat-portal]"));
}

function initialFocusElement(dialog: HTMLElement) {
  const preferred = dialog.querySelector<HTMLElement>("[autofocus], [data-autofocus]");
  if (preferred && preferred.getClientRects().length > 0) return preferred;
  return focusableElements(dialog)[0];
}

/** Provides Escape handling, focus containment/restoration, and scroll locking. */
export function useAccessibleDialog<T extends HTMLElement>(onClose: () => void, active = true): RefObject<T | null> {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialogStack.length === 0) {
      bodyOverflowBeforeDialogs = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    dialogStack = [...dialogStack, dialog];

    const focusInside = () => {
      if (dialogStack.at(-1) !== dialog || isInsideDialogSurface(dialog, document.activeElement)) return;
      (initialFocusElement(dialog) ?? dialog).focus();
    };
    focusInside();
    const focusFrame = window.requestAnimationFrame(focusInside);
    const focusTimer = window.setTimeout(focusInside, 150);
    const onFocusIn = (event: FocusEvent) => {
      if (dialogStack.at(-1) === dialog && !isInsideDialogSurface(dialog, event.target as Node)) focusInside();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack.at(-1) !== dialog) return;
      if (!dialog.contains(document.activeElement) && isInsideDialogSurface(dialog, document.activeElement)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      const focused = document.activeElement;
      if (event.shiftKey && (focused === first || !dialog.contains(focused))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (focused === last || !dialog.contains(focused))) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.clearTimeout(focusTimer);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("keydown", onKeyDown, true);
      dialogStack = dialogStack.filter((item) => item !== dialog);
      if (dialogStack.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeDialogs;
        if (previousFocus?.isConnected) previousFocus.focus();
      } else {
        const parentDialog = dialogStack.at(-1)!;
        if (previousFocus?.isConnected && parentDialog.contains(previousFocus)) previousFocus.focus();
        else initialFocusElement(parentDialog)?.focus();
      }
    };
  }, [active]);

  return dialogRef;
}
