// The hide_props.conf transport: the file the daemon's boot-property reconciliation (HideProps.kt)
// and module/service.sh both read. This module is the only place that knows where it lives; it does
// no parsing (that is domain/hide-props.js) and no privileged work beyond a read and an atomic write
// through bridge/shell.js, the quoting boundary.
//
// The path is a fixed literal, never assembled from user input. What the user types is written
// verbatim as the file's CONTENT — the file's own grammar is what constrains it, and both appliers
// only ever hand a parsed name/value to resetprop as an argv element, so nothing typed here can
// become a command.

import { DIR, deleteFile, readFile, writeFileAtomic } from "../bridge/shell.js";

export const HIDE_PROPS = DIR + "/hide_props.conf";

// The file's text. An absent file reads as empty — "nothing hidden" — which is also what a fresh
// install has. A read that throws (no root shell / no bridge) is reported so the card can say it
// could not read, rather than silently claiming nothing is configured.
export async function loadHideProps() {
  try {
    return { ok: true, text: await readFile(HIDE_PROPS) };
  } catch (e) {
    console.error("[hideProps]", e);
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Write the file atomically. Blank text removes it instead: no file and an empty file mean the same
// thing to both appliers, and removing it keeps the data dir free of a file that says nothing.
//   { ok: true } | { ok: false, error }
export async function saveHideProps(text) {
  const body = String(text == null ? "" : text);
  if (!body.trim()) return deleteFile(HIDE_PROPS);
  return writeFileAtomic(HIDE_PROPS, body.endsWith("\n") ? body : body + "\n");
}