/* Closing pop-ups by clicking outside them. */
'use strict';

// A modal <dialog>: a click on the dimmed backdrop targets the dialog itself, outside its box.
// The press must start there too, so selecting text inside and letting go outside keeps it open.
function closeOnBackdropClick(dialog, close) {
  const onBackdrop = event => {
    if (event.target !== dialog) return false;
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  let pressedOnBackdrop = false;
  dialog.addEventListener('pointerdown', event => { pressedOnBackdrop = onBackdrop(event); });
  dialog.addEventListener('click', event => {
    if (pressedOnBackdrop && onBackdrop(event)) close();
    pressedOnBackdrop = false;
  });
}

// A floating card that isn't modal: a tap or click elsewhere closes it, unless keepOpen(event) says it belongs to it.
// Pointer events, because iPhone Safari doesn't send clicks on plain text to the document; a press that starts
// inside the card (selecting its sentence) or turns into a scroll (pointercancel) never closes it.
function closeOnClickAway(panel, close, keepOpen = () => false) {
  const isOpen = () => !panel.classList.contains('hidden');
  let pressedOutside = false;
  document.addEventListener('pointerdown', event => { pressedOutside = isOpen() && !panel.contains(event.target); });
  document.addEventListener('pointercancel', () => { pressedOutside = false; });
  document.addEventListener('pointerup', event => {
    const wasOutside = pressedOutside;
    pressedOutside = false;
    if (!wasOutside || !isOpen() || panel.contains(event.target) || keepOpen(event)) return;
    close();
  });
}
