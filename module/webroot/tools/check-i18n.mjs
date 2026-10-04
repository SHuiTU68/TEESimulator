// Coverage check for the WebUI i18n dictionary.  Run: `node tools/check-i18n.mjs` from module/webroot.
//
// It re-derives every prose-looking literal from the source (comments stripped, adjacent literal
// concatenations joined back into the single runtime string they produce, plus the data-i18n /
// data-i18n-aria values in index.html), then asks js/i18n.js itself whether a zh translation
// exists. Everything it reports under UNEXPLAINED is a string that would still render in English
// after switching to 中文. Exits non-zero when it finds one, so it can gate a release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { setLocale, hasTranslation, t } = await import(new URL("../js/i18n.js", import.meta.url));

function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let mode = null; // null | line | block | dq | sq | bt
  while (i < n) {
    const c = src[i];
    const nxt = src[i + 1] || "";
    if (mode === null) {
      if (c === "/" && nxt === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && nxt === "*") { mode = "block"; i += 2; continue; }
      if (c === '"' || c === "'") { mode = c === '"' ? "dq" : "sq"; out += c; i += 1; continue; }
      if (c === "`") { mode = "bt"; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = null; out += "\n"; } i += 1; continue; }
    if (mode === "block") { if (c === "*" && nxt === "/") { mode = null; i += 2; out += " "; continue; } if (c === "\n") out += "\n"; i += 1; continue; }
    const q = mode === "dq" ? '"' : mode === "sq" ? "'" : "`";
    if (c === "\\") { out += src.slice(i, i + 2); i += 2; continue; }
    if (c === q) mode = null;
    out += c; i += 1; continue;
  }
  return out;
}

const LIT_SRC = `"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'`;
const JOINED = new RegExp(`(?:${LIT_SRC})(?:\\s*\\+\\s*(?:${LIT_SRC}))+`, "g");
const SINGLE = new RegExp(LIT_SRC, "g");
const CODEY = /[{}<>;=]|=>|&&|\|\||\$\{|\\n|\\t/;
const PATHS = /\/data\/|\/sdcard|\/system|\/proc|\/dev\/|\/tmp|\/adb|\/module|\/keystore|\/apex|\/vendor|\/product|\/meta|\.js$|\.css$|\.json$|\.xml$|\.html$/;

// Same filter the dictionary was built with: skip anything that is obviously code, a path, or an
// all-lowercase identifier, and keep prose (a multi-word phrase or a capitalised word).
function interesting(s) {
  if (s.length < 3 || !/[A-Za-z]/.test(s)) return false;
  if (CODEY.test(s) || PATHS.test(s)) return false;
  if (/^[a-z0-9_.\-:/ @]+$/.test(s)) return false;
  if (!/[A-Za-z]\s+[A-Za-z]/.test(s) && !/^[A-Z][A-Za-z]{2,}$/.test(s)) return false;
  return true;
}
const unq = (lit) => lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");

function walk(d) {
  const out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const candidates = new Map(); // file -> Set(string)
for (const p of walk(path.join(ROOT, "js"))) {
  if (p.endsWith("/i18n.js")) continue; // the dictionary itself
  const src = stripComments(fs.readFileSync(p, "utf8"));
  const rel = path.relative(ROOT, p);
  const set = candidates.get(rel) || new Set();
  const spans = [];
  for (const m of src.matchAll(JOINED)) {
    spans.push([m.index, m.index + m[0].length]);
    const full = [...m[0].matchAll(new RegExp(LIT_SRC, "g"))].map((x) => unq(x[0])).join("");
    if (interesting(full)) set.add(full);
  }
  for (const m of src.matchAll(SINGLE)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const v = unq(m[0]);
    if (interesting(v)) set.add(v);
  }
  candidates.set(rel, set);
}

// The static chrome is localized by applyStatic(), not by el(), so read its keys too.
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const htmlSet = new Set();
for (const m of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) htmlSet.add(m[1]);
candidates.set("index.html", htmlSet);

// Strings that are deliberately NOT translated. Every entry was checked by hand and falls into
// one of three groups:
//   * console-only diagnostics — developer output that never reaches the screen;
//   * protocol / brand / enum tokens — verbatim by design (HTTP verbs, key purposes, the KeyMint
//     assurance level names, the brand name inside a generated filename). A row of identifiers
//     should read exactly like logcat next to it;
//   * one fragment of a sentence assembled from variables — only the JOINED sentence renders, and
//     RULES translates that (the fragment alone never reaches the DOM).
// Anything outside this list that has no translation is a real gap and will be reported.
const ALLOW_PREFIX = ["[app] ", "[config]", "[logs", "[keyAdmin]"];
const ALLOW_EXACT = new Set([
  "GET",
  "POST",
  " (NO TOKEN)",
  "TEESimulator",
  "AttestKey",
  "SelfSigned",
  "Software",
  "StrongBox",
  "TrustedEnvironment",
  "Hook",
  "Interceptor",
  "INPUT",
  // fragments (joined sentence is in RULES / the dictionary)
  "A profile named ",
  " KB to ",
  " installed since TEESimulator started ",
  "Auto-include on — ",
  "Auto-included by profile ",
  "In scope automatically — tap to pin it to ",
  "Advanced: targets caller uid ",
  "Used by profile “",
  "Installed for user ",
  " (work profile)",
  " — tap to pin it here instead.",
  ". To exclude it, turn off Auto-include new apps.",
  "No apps match “",
  "  (Android API ",
  " real device key(s) hidden — switch to All to show them.",
  "Delete selected (",
  "No keys match “",
  " over the current module, then reboot to apply.",
]);
function allowed(s) {
  return ALLOW_PREFIX.some((p) => s.startsWith(p)) || ALLOW_EXACT.has(s);
}

setLocale("zh");
let total = 0;
let explained = 0;
const unexplained = [];
for (const [file, set] of [...candidates].sort()) {
  for (const s of [...set].sort()) {
    total += 1;
    if (typeof s !== "string") continue;
    if (hasTranslation(s)) continue;
    if (allowed(s)) explained += 1;
    else unexplained.push([file, s]);
  }
}
const translated = total - explained - unexplained.length;
console.log(`candidates: ${total}`);
console.log(`  translated:        ${translated}`);
console.log(`  intentionally raw: ${explained}`);
console.log(`  UNEXPLAINED:       ${unexplained.length}`);
console.log(`effective coverage: ${(100 * (translated + explained) / total).toFixed(1)}%`);
if (unexplained.length) {
  console.log("\n--- UNEXPLAINED (real gaps) ---");
  for (const [file, s] of unexplained) console.log(`${file}: ${JSON.stringify(s)}`);
}
console.log("\n--- spot checks ---");
for (const s of [
  "Profiles",
  "Save",
  "checking…",
  "2 apps targeted",
  "Saved 12 KB to /x/y.zip",
  "Name is required.",
  "Invalid name: !@#",
  "Used by profile “work”",
  'Delete keybox "corp.xml"? This cannot be undone.',
]) {
  console.log(`${JSON.stringify(s)} -> ${JSON.stringify(t(s))}`);
}
process.exitCode = unexplained.length ? 1 : 0;