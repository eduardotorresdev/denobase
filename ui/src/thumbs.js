// Thumbs option of a file field: the same checks as the server (PB's FileField.ValidateSettings) and a tags input to
// compose the list. Collections are declared in code, so the editor ends in the `thumbs: [...]` line to paste there.
import { copyButton } from "./ui.js";

/** PB's filesystem.ThumbSizeRegex. */
const THUMB_SIZE_RE = /^(\d+)x(\d+)(t|b|f)?$/;
/** PB's NotIn: both sides zero renders nothing. */
const ZERO_SIZES = ["0x0", "0x0t", "0x0b", "0x0f"];

/** PB's error message for one size, or "" when it is valid. */
export function thumbError(size) {
  if (size === "") return "";
  if (ZERO_SIZES.includes(size)) return "Must not be in list.";
  return THUMB_SIZE_RE.test(size) ? "" : "Must be in a valid format.";
}

/** Splits typed text (comma or whitespace separated) into sizes not yet in `list`. */
export function addThumbs(list, text) {
  const out = [...list];
  for (const s of String(text).split(/[\s,]+/)) if (s && !out.includes(s)) out.push(s);
  return out;
}

/** The option as written in a collection declared in code. */
export function thumbsSnippet(list) {
  return `thumbs: [${list.map((s) => JSON.stringify(s)).join(", ")}],`;
}

/** Tags input for a file field's thumbs: Enter/comma adds, Backspace on empty removes the last, × removes one. */
export function thumbsEditor(initial = []) {
  const state = store({ tags: [...initial], text: "" });
  const commit = () => {
    state.tags = addThumbs(state.tags, state.text);
    state.text = "";
  };
  const remove = (i) => state.tags = state.tags.filter((_, j) => j !== i);
  return t.div(
    { className: "stack thumbs-editor" },
    t.div(
      { className: "tags-input input" },
      () =>
        state.tags.map((s, i) =>
          t.span(
            { className: `tag ${thumbError(s) ? "invalid" : ""}`, title: thumbError(s) },
            t.span({ className: "mono", textContent: s }),
            t.button({
              type: "button",
              className: "tag-x",
              title: `Remove ${s}`,
              textContent: "×",
              onclick: () => remove(i),
            }),
          )
        ),
      t.input({
        className: "tags-input-text",
        placeholder: "e.g. 100x100, 0x300, 200x200f",
        value: () => state.text,
        oninput: (e) => {
          state.text = e.target.value;
          if (/[\s,]$/.test(state.text)) commit();
        },
        onkeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !state.text && state.tags.length) remove(state.tags.length - 1);
        },
        onblur: commit,
      }),
    ),
    t.span({
      className: "field-error",
      textContent: () => {
        const bad = state.tags.find((s) => thumbError(s));
        return bad ? `${bad}: ${thumbError(bad)}` : "";
      },
    }),
    t.p({
      className: "muted",
      textContent: "WxH crops to center, WxHt top, WxHb bottom, WxHf fits inside; 0xH or Wx0 keeps the ratio.",
    }),
    t.div(
      { className: "row" },
      t.code({ className: "mono", textContent: () => thumbsSnippet(state.tags) }),
      copyButton(() => thumbsSnippet(state.tags)),
    ),
  );
}
