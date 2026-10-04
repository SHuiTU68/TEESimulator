// The pure half of hide_props.conf — the line grammar the module implements three times: here (for
// the WebUI's summary), in the daemon (HideProps.kt, which owns the boot-state reconciliation) and in
// module/service.sh (the applier that runs even if the daemon never starts). All three read the one
// file, so the grammar lives here in the same shape as those two.
//
// The file is a list of properties to take control of, one per line:
//   * a bare name DELETES the property;
//   * "name=value" OVERRIDES it with that value;
//   * '#' starts a comment that runs to the end of the line, and whitespace is insignificant.
//
// A property that is not listed is still reconciled to the locked/Verified boot state the module
// attests — the list only ever hides one property or pins it, it never switches the reconciliation
// off. No DOM, no bridge, no I/O: this is string math over the file's text, so it is unit-testable.

// An Android property name: a letter, then letters, digits, '.', '-' or '_'. Used only to WARN in the
// UI — the two appliers pass whatever is on the line straight to resetprop, so the file stays the
// source of truth and a name this rejects is still attempted on the device.
export const PROP_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

// Parse the file's text into the entries it describes.
//   entries: [{ name, value }]  — value "" means "delete this property"
//   ignored: [line]             — a half-written line ("=1", "prop="), which pins and hides nothing
// A line that has nothing but a comment or whitespace simply is not an entry.
export function parseHideProps(text) {
  const entries = [];
  const ignored = [];
  for (const raw of String(text == null ? "" : text).split(/\r?\n/)) {
    const line = raw.split("#")[0].replace(/\s+/g, "");
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq < 0) {
      entries.push({ name: line, value: "" });
      continue;
    }
    const name = line.slice(0, eq);
    const value = line.slice(eq + 1);
    // Half a line means nothing was meant by it — the same reason the appliers skip it rather than
    // write an empty value.
    if (!name || !value) {
      ignored.push(raw.trim());
      continue;
    }
    entries.push({ name, value });
  }
  return { entries, ignored };
}

// The counts the card summarises: how many properties the file names, and how they split.
export function summarize(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const hidden = list.filter((e) => !e.value).length;
  return { total: list.length, hidden, pinned: list.length - hidden };
}

// The names that do not look like a property at all, for the card's warning. Purely advisory: the
// appliers pass whatever the line says to resetprop, so this never decides anything.
export function suspiciousNames(entries) {
  return (Array.isArray(entries) ? entries : []).filter((e) => !PROP_NAME_RE.test(e.name)).map((e) => e.name);
}
