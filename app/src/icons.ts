// A button says two things at once: a word, and the glyph that stands in for
// the word when its rail is collapsed to one icon wide (index.html's
// [data-rail="icons"] rules blank the text and draw data-icon instead).
//
// They are written together because they are the same label. Six buttons
// rewrite their text as the thing they do changes -- Play becomes Pause,
// Record becomes Stop -- and a glyph updated in a second place is a glyph that
// eventually disagrees with the word under it.

/** Set a button's word and the icon that replaces it in a collapsed rail. */
export function say(btn: HTMLButtonElement, text: string, icon: string) {
  btn.textContent = text;
  btn.dataset.icon = icon;
}
