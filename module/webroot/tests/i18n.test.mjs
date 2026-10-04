// Device-free tests for the WebUI i18n layer: the English-source dictionary and its rules, the
// locale store, and the one render boundary (ui/dom.js) that makes every section translatable
// without editing a single literal in a view.
//
// Run from module/webroot: `node --test tests/i18n.test.mjs` (or just `node --test`).
// Nothing here needs jsdom: i18n.js touches the browser lazily and guards every access, and the
// only globals dom.js needs at import time are the ones ui/nav.js uses to register its popstate
// listener — so a ~40-line stub is enough to exercise el() and toast() for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// --- minimal DOM + storage stub ---------------------------------------------
// Node 24 declares `navigator` (and, under a flag, `localStorage`) as getter-only globals, so the
// stubs are installed with defineProperty rather than plain assignment.
function def(name, value) {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    try { globalThis[name] = value; } catch { /* leave Node's own global alone */ }
  }
}

function fakeNode(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(), nodeType: 1,
    className: "", value: "", hidden: false, disabled: false, checked: false,
    _text: "", _attrs: {}, children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text; },
    append(...kids) { for (const k of kids) this.children.push(k); },
    appendChild(k) { this.children.push(k); return k; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    addEventListener() {}, removeEventListener() {}, focus() {}, blur() {}, remove() {},
  };
}

const byId = new Map([["toast", fakeNode("div")]]);
const stored = new Map();
def("window", { addEventListener() {}, removeEventListener() {} });
def("document", {
  createElement: (tag) => fakeNode(tag),
  createTextNode: (s) => ({ nodeType: 3, text: String(s) }),
  getElementById: (id) => byId.get(id) || null,
  documentElement: { lang: "" },
  querySelectorAll: () => [],
  addEventListener() {},
});
def("localStorage", {
  getItem: (k) => (stored.has(k) ? stored.get(k) : null),
  setItem: (k, v) => stored.set(k, String(v)),
  removeItem: (k) => stored.delete(k),
  clear: () => stored.clear(),
});

// Dynamic imports, so the stubs exist before i18n.js resolves the persisted locale at load time.
const i18n = await import("../js/i18n.js");
const { el, toast } = await import("../js/ui/dom.js");
const { validateConfig, validateProfile } = await import("../js/domain/validate.js");

// --- locale store ------------------------------------------------------------

test("English is the default locale, and t() is the identity there", () => {
  i18n.setLocale("en");
  assert.equal(i18n.getLocale(), "en");
  assert.equal(i18n.isEnglish(), true);
  for (const s of ["Profiles", "Save", "checking…", "2 apps targeted"]) assert.equal(i18n.t(s), s);
});

test("getLocales() lists en then zh, and the metadata feeds the toggle button", () => {
  assert.deepEqual(i18n.getLocales().map((l) => l.id), ["en", "zh"]);
  assert.equal(i18n.getLocaleMeta("en").short, "EN");
  assert.equal(i18n.getLocaleMeta("zh").short, "中");
  assert.equal(i18n.getLocaleMeta("zh").label, "简体中文");
  i18n.setLocale("zh");
  assert.equal(i18n.getLocaleMeta().id, "zh", "defaults to the active locale");
  i18n.setLocale("en");
});

test("setLocale persists, notifies once per real change, and rejects unknown ids", () => {
  i18n.setLocale("en");
  const seen = [];
  const off = i18n.onLocaleChange((loc) => seen.push(loc));
  i18n.setLocale("en"); // already active: no event
  assert.deepEqual(seen, []);
  i18n.setLocale("zh");
  assert.equal(stored.get("teesim.locale"), "zh");
  assert.deepEqual(seen, ["zh"]);
  i18n.setLocale("klingon"); // unknown: ignored, never persisted
  assert.equal(i18n.getLocale(), "zh");
  assert.equal(stored.get("teesim.locale"), "zh");
  off();
  i18n.setLocale("en");
  assert.deepEqual(seen, ["zh"], "unsubscribing must stop delivery");
});

test("toggleLocale cycles en -> zh -> en", () => {
  i18n.setLocale("en");
  assert.equal(i18n.toggleLocale(), "zh");
  assert.equal(i18n.toggleLocale(), "en");
});

// --- dictionary + rules ------------------------------------------------------

test("the shared chrome and the five destinations are translated", () => {
  i18n.setLocale("zh");
  const pairs = [
    ["Profiles", "配置文件"], ["Keyboxes", "密钥盒"], ["Keys", "密钥"],
    ["System", "系统"], ["Logs", "日志"], ["Sections", "分区"],
    ["Switch language", "切换语言"], ["checking…", "检测中…"],
    ["running", "运行中"], ["unreachable", "不可达"],
    ["Save", "保存"], ["Cancel", "取消"], ["Delete", "删除"],
  ];
  for (const [en, zh] of pairs) assert.equal(i18n.t(en), zh, `t(${JSON.stringify(en)})`);
  i18n.setLocale("en");
});

test("rules translate the sentences assembled from variables", () => {
  i18n.setLocale("zh");
  const pairs = [
    ["2 apps targeted", "已覆盖 2 个应用"],
    ["Saved 12 KB to /x/y.zip", "已保存 12 KB 到 /x/y.zip"],
    ['Delete keybox "corp.xml"? This cannot be undone.', "删除密钥盒 “corp.xml”？此操作无法撤销。"],
    ["Used by profile “work”", "被配置文件 “work”使用"],
    ["Invalid name: !@#", "名称无效：!@#"],
    ["Name is required.", "名称为必填项。"],
    ["Refresh failed: socket closed", "刷新失败：socket closed"],
  ];
  for (const [en, zh] of pairs) assert.equal(i18n.t(en), zh, `t(${JSON.stringify(en)})`);
  i18n.setLocale("en");
});

test("dictionary keys are unique modulo case, so the folded lookup stays unambiguous", () => {
  // The render path retries a lookup case-insensitively (ZH_FOLDED in js/i18n.js), which is only
  // sound while no two keys differ by case alone. These are the pairs that could collide.
  i18n.setLocale("zh");
  for (const [a, b] of [["Recent", "recent"], ["update available", "Update available"]]) {
    assert.equal(i18n.t(a), i18n.t(b), `${a} / ${b} must agree`);
  }
  i18n.setLocale("en");
});

test("strings that carry logic stay verbatim, whatever the locale", () => {
  i18n.setLocale("zh");
  const raw = [
    "com.example.app", "com.example.app@10", "uid:1000",                  // package / app entries
    "class:com.example.app", "app:com.example.app", "purpose:attestation", // log filter tokens
    "/data/adb/teesim/config.json",                                       // paths
    "Software", "StrongBox", "Interceptor",                               // KeyMint enums, by design
    "GET", "POST",
  ];
  for (const s of raw) assert.equal(i18n.t(s), s, `${s} must stay verbatim`);
  i18n.setLocale("en");
});

test("an unknown string falls back to its source, and non-strings pass through", () => {
  i18n.setLocale("zh");
  assert.equal(i18n.t("zzz not in the dictionary zzz"), "zzz not in the dictionary zzz");
  assert.equal(i18n.t(""), "");
  assert.equal(i18n.t(null), null);
  assert.equal(i18n.t(undefined), undefined);
  i18n.setLocale("en");
});

test("t() interpolates {placeholders} and leaves unknown ones intact", () => {
  i18n.setLocale("en");
  assert.equal(i18n.t("Deleted {n} keys", { n: 3 }), "Deleted 3 keys");
  assert.equal(i18n.t("{x}", { y: 1 }), "{x}");
});

// --- the render boundary -----------------------------------------------------

test("el() translates text, string children and copy-bearing attributes", () => {
  i18n.setLocale("zh");
  const card = el("div", { class: "card", text: "Save", title: "Profiles" });
  assert.equal(card.textContent, "保存");
  assert.equal(card.getAttribute("title"), "配置文件");
  assert.equal(card.className, "card", "class names are structure, not copy");

  const wrap = el("span", {}, ["Profiles", 3]);
  assert.equal(wrap.children[0].text, "配置文件", "string children go through t() too");
  assert.equal(wrap.children[1].text, "3", "numbers pass through untouched");
});

test("el() never translates a form value, but does translate a placeholder", () => {
  i18n.setLocale("zh");
  const input = el("input", { value: "Save", placeholder: "Search" });
  assert.equal(input.value, "Save", "a value is data: translating it would corrupt it");
  assert.equal(input.getAttribute("placeholder"), "搜索");
  const box = el("input", { type: "checkbox", checked: true });
  assert.equal(box.checked, true);
});

test("el() is a no-op in English", () => {
  i18n.setLocale("en");
  const node = el("div", { text: "Save", title: "Profiles" }, ["Keys"]);
  assert.equal(node.textContent, "Save");
  assert.equal(node.getAttribute("title"), "Profiles");
  assert.equal(node.children[0].text, "Keys");
});

test("toast() translates its message — the one write path that skips el()", () => {
  const host = byId.get("toast");
  i18n.setLocale("zh");
  toast("daemon unreachable");
  assert.equal(host.textContent, "守护进程不可达");
  i18n.setLocale("en");
  toast("daemon unreachable");
  assert.equal(host.textContent, "daemon unreachable");
});

test("applyStatic() localizes the markup marked data-i18n / data-i18n-aria", () => {
  const label = fakeNode("span");
  label.setAttribute("data-i18n", "Profiles");
  const nav = fakeNode("nav");
  nav.setAttribute("data-i18n-aria", "Sections");
  const root = {
    querySelectorAll: (sel) =>
      sel === "[data-i18n]" ? [label] : sel === "[data-i18n-aria]" ? [nav] : [],
  };
  i18n.setLocale("zh");
  i18n.applyStatic(root);
  assert.equal(label.textContent, "配置文件");
  assert.equal(nav.getAttribute("aria-label"), "分区");
  assert.equal(document.documentElement.lang, "zh-Hans", "the document language follows the locale");
  i18n.setLocale("en");
  i18n.applyStatic(root);
  assert.equal(label.textContent, "Profiles");
  assert.equal(document.documentElement.lang, "en");
});

// --- end to end: the messages real validators emit ---------------------------

test("every message the domain validators can emit has a translation", () => {
  // Harvest the real strings by tripping the real validators: these are the messages that surface
  // in the Save / import error list, so a gap here is a user-visible gap.
  const msgs = new Set();
  const harvest = (r) =>
    (Array.isArray(r) ? r : (r && r.errors) || []).forEach((e) => msgs.add(e.msg));
  harvest(validateProfile("ok", {}));                // every required field missing
  harvest(validateProfile("Bad name!", {}));         // profile name violates PROFILE_RE
  harvest(validateProfile("ok", null));              // not an object
  harvest(validateProfile("ok", {
    keybox: "nope", mode: "zzz", apps: ["com.foo bad"],
    patchLevel: { system: "??", vendor: "??", boot: "??" }, osVersion: "1.2.3.4",
  }));                                               // malformed scalars + app list
  harvest(validateConfig(null));
  harvest(validateConfig({ version: 99 }));
  harvest(validateConfig({ version: 1, profiles: [] }));
  harvest(validateConfig({ version: 1, profiles: {
    a: { keybox: "keybox.xml", mode: "patch", apps: ["com.x"] },
    b: { keybox: "keybox.xml", mode: "patch", apps: ["com.x"] },
  }}));                                              // the cross-profile uniqueness rule
  assert.ok(msgs.size >= 10, `expected a decent harvest, got ${msgs.size}`);
  i18n.setLocale("zh");
  const untranslated = [...msgs].filter((m) => !i18n.hasTranslation(m));
  assert.deepEqual(untranslated, [], `untranslated validator message(s): ${JSON.stringify(untranslated)}`);
  // The validators lower-case a field label; the folded lookup must still resolve it.
  assert.equal(i18n.t("Invalid os version: 1.2.3.4"), "OS 版本无效：1.2.3.4");
  i18n.setLocale("en");
});

test("the dictionary is local: no network reference anywhere in js/i18n.js", async () => {
  // The WebUI runs under CSP default-src 'self', so the translation table must ship with the app.
  const src = await readFile(new URL("../js/i18n.js", import.meta.url), "utf8");
  assert.equal(/https?:\/\//.test(src), false, "no remote URL may appear in the dictionary module");
  assert.equal(/\bimport\s*\(/.test(src), false, "no dynamic import either");
});
