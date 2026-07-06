function desktopKeyboardVisibleModalIds() {
  return [
    "settingsModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "workspaceCreateModal",
    "shortcutsModal",
    "searchPalette",
    "tempTerminalModal",
  ];
}

function desktopKeyboardVisibleModal() {
  return desktopKeyboardVisibleModalIds()
    .map((id) => el(id))
    .find((modal) => modal && modal.style.display === "grid") || null;
}

function desktopKeyboardTempTerminalOwnsEvent(event) {
  const modal = el("tempTerminalModal");
  return !!(
    modal &&
    modal.style.display === "grid" &&
    event &&
    event.target &&
    modal.contains(event.target)
  );
}

function desktopKeyboardFocusableElements(root) {
  return Array.from(
    root.querySelectorAll(
      'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((node) => node.offsetParent !== null || node === document.activeElement);
}

function handleModalFocusTrapKeydown(event) {
  if (event.key !== "Tab") return;
  const modal = desktopKeyboardVisibleModal();
  if (!modal) return;

  // The temporary terminal is a modal visually, but its xterm instance owns
  // terminal editing keys, including Tab completion. Do not turn Tab into
  // browser focus navigation while the event starts inside that terminal.
  if (modal.id === "tempTerminalModal" && desktopKeyboardTempTerminalOwnsEvent(event)) return;

  const focusable = desktopKeyboardFocusableElements(modal);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const active = document.activeElement;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey) {
    if (active === first || !modal.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last || !modal.contains(active)) {
    event.preventDefault();
    first.focus();
  }
}

function handleTerminalClipboardKeydown(event) {
  if (editableEventTarget(event)) return;
  const key = String(event.key || "").toLowerCase();
  const copyKey =
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    key === "c";
  const pasteKey =
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    key === "v";
  if (copyKey && term && term.getSelection && term.getSelection()) {
    event.preventDefault();
    copySelection();
  } else if (pasteKey) {
    event.preventDefault();
    pasteClipboard();
  }
}

function handleDesktopCloseShortcutKeydown(event) {
  if (desktopKeyboardVisibleModal()) return false;
  return closeShortcutKeydown(event);
}

function setupDesktopKeyboardHandling() {
  window.addEventListener("keydown", handleDesktopCloseShortcutKeydown, true);
  window.addEventListener("keydown", handleGlobalShortcut, true);
  document.addEventListener("keydown", handleModalFocusTrapKeydown);
  document.addEventListener("keydown", handleTerminalClipboardKeydown);
}
