// Locale store + source-string dictionary. The WebUI's only translation entry point.
//
// HOW IT HOOKS IN: every piece of user-visible text in this app reaches the DOM through
// one place — el() in js/ui/dom.js (its `text`, its string children, and its aria-label /
// placeholder / title attributes), plus toast() and the dialog labels. Translating at that
// one boundary means all five sections and every overlay are covered without rewriting a
// single literal in a view, and — crucially — the strings that carry LOGIC (filter tokens
// like "class:", className/id strings, enum values, KeyAdmin action names, shell commands,
// file paths) are never touched, so switching language can never change behaviour.
//
// WHY "ENGLISH IS THE KEY": keys are the verbatim English source strings. In `en` t()
// returns the argument unchanged (English stays the default language, so the upstream diff
// is additive); in `zh` it looks the string up and falls back to the original when it is
// not found (graceful degradation for anything data-derived, e.g. daemon error text).
// Sentences assembled from variables cannot be keyed verbatim, so RULES holds ordered
// regex rules for them — first match wins, and a rule may return null to fall through.
//
// Offline by contract: this is a local module and loads nothing external (CSP 'self').

export const LOCALES = [
  { id: "en", short: "EN", label: "English" },
  { id: "zh", short: "中", label: "简体中文" },
];

const DEFAULT_LOCALE = "en";
const STORAGE_KEY = "teesim.locale";
const DEBUG_KEY = "teesim.i18n.debug";

// --- storage (guarded: private mode / disabled storage must not break the UI) ---
function store() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
function readStored() {
  const s = store();
  if (!s) return null;
  try {
    return s.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeStored(id) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore — the choice just will not survive a reload */
  }
}
// Opt-in reporting of untranslated strings: localStorage["teesim.i18n.debug"]="1"
// (or append ?i18nDebug=1). Off by default so an ordinary session logs nothing.
function debugOn() {
  const s = store();
  try {
    if (s && s.getItem(DEBUG_KEY) === "1") return true;
  } catch {
    /* ignore */
  }
  try {
    return typeof location !== "undefined" && /[?&]i18nDebug=1\b/.test(location.search);
  } catch {
    return false;
  }
}

// --- locale state -------------------------------------------------------------
function isKnownLocale(id) {
  return LOCALES.some((l) => l.id === id);
}
let locale = (() => {
  const v = readStored();
  return isKnownLocale(v) ? v : DEFAULT_LOCALE;
})();
const listeners = new Set();

export function getLocale() {
  return locale;
}
export function getLocales() {
  return LOCALES.slice();
}
export function getLocaleMeta(id = locale) {
  return LOCALES.find((l) => l.id === id) || LOCALES[0];
}
export function isEnglish() {
  return locale === DEFAULT_LOCALE;
}
export function setLocale(id) {
  if (!isKnownLocale(id) || id === locale) return;
  locale = id;
  writeStored(id);
  applyDocumentLang();
  for (const fn of [...listeners]) {
    try {
      fn(locale);
    } catch (e) {
      console.error("[i18n] locale listener failed:", e);
    }
  }
}
// Handy for a single toggle button: cycle to the next locale in LOCALES order.
export function toggleLocale() {
  const i = LOCALES.findIndex((l) => l.id === locale);
  setLocale(LOCALES[(i + 1) % LOCALES.length].id);
  return locale;
}
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function applyDocumentLang() {
  try {
    document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
  } catch {
    /* non-DOM context */
  }
}

// --- missing-string diagnostics ----------------------------------------------
const missing = new Set();
export function missingStrings() {
  return [...missing];
}
function noteMissing(s) {
  if (!debugOn() || missing.has(s)) return;
  // Only prose-looking strings; data (paths, ids, daemon text) is expected to stay verbatim.
  if (!/^[A-Za-z][A-Za-z0-9 ,.'’()\-—–:;!?/]{2,}$/.test(s)) return;
  missing.add(s);
  try {
    window.__i18nMissing = missing;
  } catch {
    /* ignore */
  }
  console.warn("[i18n] untranslated:", JSON.stringify(s));
}

// --- small helpers ------------------------------------------------------------
function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
// "User 10" -> "用户 10"; anything else goes through the dictionary.
function userLabel(s) {
  const m = /^User (\d+)$/.exec(s);
  return m ? `用户 ${m[1]}` : t(s);
}

// --- lookup -------------------------------------------------------------------
function lookup(text) {
  if (Object.prototype.hasOwnProperty.call(ZH, text)) return ZH[text];
  for (const [re, to] of RULES) {
    const m = re.exec(text);
    if (!m) continue;
    const out = typeof to === "function" ? to(m) : to.replace(/\$(\d)/g, (_, d) => m[Number(d)] || "");
    if (out != null) return out;
  }
  // Last resort: the same prose in another case (see ZH_FOLDED).
  const folded = ZH_FOLDED.get(text.toLowerCase());
  return folded != null ? folded : null;
}
// True when the string would change under the current (non-en) locale. Used by the
// coverage check in tools/ and by tests; not part of the render path.
export function hasTranslation(text) {
  return lookup(text) != null;
}

// The single translation call. `params` fills `{name}` placeholders when a caller
// wants to interpolate explicitly (most sentences are handled by RULES instead).
export function t(text, params) {
  if (typeof text !== "string" || text === "") return text;
  let out = text;
  if (locale !== DEFAULT_LOCALE) {
    const hit = lookup(text);
    if (hit == null) noteMissing(text);
    else out = hit;
  }
  if (params) out = out.replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? `{${k}}` : String(params[k])));
  return out;
}

// Translate the static markup: elements carrying data-i18n (textContent) or
// data-i18n-aria (aria-label). index.html marks its own strings with those attributes,
// so the static chrome is covered without any blind DOM walking.
export function applyStatic(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope) return;
  for (const n of scope.querySelectorAll("[data-i18n]")) {
    const src = n.getAttribute("data-i18n");
    if (src) n.textContent = t(src);
  }
  for (const n of scope.querySelectorAll("[data-i18n-aria]")) {
    const src = n.getAttribute("data-i18n-aria");
    if (src) n.setAttribute("aria-label", t(src));
  }
  applyDocumentLang();
}

// --- dictionary (English source -> 简体中文) ---------------------------------
const ZH = {
  // ---- shared chrome / primitives -------------------------------------------
  "checking…": "检测中…",
  running: "运行中",
  unreachable: "不可达",
  "Switch language": "切换语言",
  Sections: "分区",
  "update available": "有可用更新",

  // ---- bottom navigation / section titles -----------------------------------
  Profiles: "配置文件",
  Keyboxes: "密钥盒",
  Keys: "密钥",
  System: "系统",
  Logs: "日志",
  Keybox: "密钥盒",
  Attestation: "认证",
  Scope: "作用域",

  // ---- generic actions ------------------------------------------------------
  Save: "保存",
  Cancel: "取消",
  Confirm: "确认",
  OK: "确定",
  Close: "关闭",
  Delete: "删除",
  Add: "添加",
  Clear: "清除",
  Done: "完成",
  Enter: "回车",
  Discard: "放弃",
  Keep: "保留",
  Create: "创建",
  Saved: "已保存",
  Rename: "重命名",
  Import: "导入",
  Install: "安装",
  Update: "更新",
  All: "全部",
  Search: "搜索",
  Filter: "筛选",
  "Filter •": "筛选 •",
  Pause: "暂停",
  Resume: "继续",
  Recent: "最近",
  Selected: "已选",
  Owner: "所有者",
  User: "用户",
  Name: "名称",
  "Select all": "全选",
  "Unselect all": "取消全选",
  "Invert": "反选",
  "Inverse selection": "反选",
  "Sort order": "排序方式",
  "Not installed": "未安装",
  "No apps": "无应用",

  // ---- config: profile list -------------------------------------------------
  "Add profile": "添加配置文件",
  "Back to profiles": "返回配置文件列表",
  "Edit profile": "编辑配置文件",
  "Remove profile": "移除配置文件",
  "Profile name": "配置文件名称",
  "New profile name": "新配置文件名",
  "No profiles yet. Add one to start attesting for apps.": "还没有配置文件。添加一个即可开始为应用提供认证。",
  "Device identity": "设备标识",
  "Patch & OS levels": "补丁与 OS 级别",
  "Target apps": "目标应用",
  Unsaved: "未保存",
  "Unsaved changes": "未保存的更改",
  "Ready to save": "可以保存了",
  "Create starter config": "创建初始配置",
  "Clear usage": "清除使用记录",
  "Pin it here": "固定到此处",
  "Target it": "设为目标",
  Frequency: "频率",
  "Recently used": "最近使用",
  "Install time": "安装时间",
  "Sort by": "排序依据",
  "Most key requests first (default).": "密钥请求次数多的排前面（默认）。",
  "Last requested first.": "最近请求过的排前面。",
  "Newest installs first.": "最新安装的排前面。",
  "Keep the app selection changes you made?": "要保留你对应用选择所做的更改吗？",
  "The module seeds config.json on install. You can create a starter config now.":
    "模块在安装时会生成 config.json。你现在可以创建一个初始配置。",
  "Fix or remove the file on disk — the WebUI will not overwrite a config it cannot read.":
    "请在磁盘上修复或删除该文件 —— WebUI 不会覆盖无法读取的配置。",
  "Each overrides one attested device id. Leave a field empty to use the value harvested from the device.":
    "每一项都会覆盖一个被认证的设备标识。留空则使用从本机采集到的值。",
  "from the device build property; omitted if unset": "取自设备 build 属性；未设置时省略",
  "harvested from this device.": "从本机采集到的值。",
  "not harvested — this tag will be omitted": "未采集 —— 该标签将被省略",
  "Name must be 1-32 chars: letters, digits, - or _.": "名称须为 1-32 个字符：字母、数字、- 或 _。",

  // ---- scope editor ---------------------------------------------------------
  "Configure scope": "配置作用域",
  "Configure scope →": "配置作用域 →",
  "Back to profile": "返回配置文件",
  "All users": "所有用户",
  "Show apps from every Android user": "显示所有 Android 用户的应用",
  "Search apps, packages, users, or uid…": "搜索应用、包名、用户或 uid…",
  "In scope": "在作用域内",
  "Requested a key since boot": "自开机以来请求过密钥",
  "No app has requested a key since boot yet.": "自开机以来还没有应用请求过密钥。",
  "No apps found on the device.": "设备上未找到任何应用。",
  "No apps match.": "没有匹配的应用。",
  "Nothing in scope yet — tap an app to add it.": "作用域中还什么都没有 —— 点按一个应用即可添加。",
  "Reading installed apps…": "正在读取已安装应用…",
  "Could not read the device app list": "无法读取设备应用列表",
  "No apps yet.": "还没有应用。",
  "Auto-include on — no new apps in scope yet.": "自动包含已开启 —— 作用域中还没有新应用。",
  "Auto-include is idle until the package baseline is seeded.":
    "在包基线完成采集之前，自动包含处于空闲状态。",
  "Auto-include is on — dashed apps are in scope automatically. Tap one to pin it here.":
    "自动包含已开启 —— 虚线应用会自动进入作用域。点按其中一个即可固定到此处。",
  // Note the leading space: scope-view renders this as the second half of the auto-note line.
  " Auto-include updates when you save.": " 保存后自动包含才会更新。",
  "advanced uid": "高级 uid",
  "system uid": "系统 uid",
  auto: "自动",
  disabled: "已禁用",

  // ---- keys -----------------------------------------------------------------
  "(no alias)": "（无别名）",
  Algorithm: "算法",
  Created: "创建时间",
  Delegated: "已委托",
  Generated: "已生成",
  Patched: "已修补",
  Spoofed: "已伪造",
  Untouched: "未改动",
  creating: "创建中",
  live: "有效",
  orphaned: "孤立",
  "Selection actions": "选择操作",
  "Select filtered": "选择筛选结果",
  "Which keys to list": "列出哪些密钥",
  "Stored keys": "已存储的密钥",
  "Only keys this module spoofed": "仅本模块伪造的密钥",
  "Include the apps' own real device keys": "包含应用自身的真实设备密钥",
  "No keys.": "没有密钥。",
  "No real keys to hide": "没有可隐藏的真实密钥",
  "Deleting…": "正在删除…",
  "Daemon key capability unavailable.": "守护进程的密钥能力不可用。",
  "Key listing is not available on this Android version.": "此 Android 版本不支持列出密钥。",
  "Filter — text, or tap a badge (class: app: purpose:)":
    "筛选 —— 输入文本，或点按徽标（class:、app:、purpose:）",
  "This module hasn't minted any keys for the target apps yet.":
    "本模块尚未为目标应用生成任何密钥。",
  "Play Integrity may be outside TEESimulator's control.":
    "Play Integrity 可能不受 TEESimulator 控制。",
  "On Android 10 and 11 there is no keystore2 database to inspect, and the keys the module generates are session-scoped — kept only until the keystore restarts (persistence there is not yet implemented).":
    "Android 10 与 11 没有可供检查的 keystore2 数据库，且模块生成的密钥是会话级的 —— 只在 keystore 重启前保留（该处的持久化尚未实现）。",
  "The Play Integrity key (com.android.vending, integrity.api.key.alias) is untouched, so it roots in the real TEE and Play Integrity can attest through it, bypassing the keybox. Switch to All and delete it to force attestation through a key this module controls.":
    "Play Integrity 密钥（com.android.vending, integrity.api.key.alias）未被改动，因此它根植于真实 TEE，Play Integrity 可以绕过密钥盒经它完成认证。切换到“全部”并删除它，即可强制改用本模块控制的密钥进行认证。",

  // ---- keyboxes -------------------------------------------------------------
  "Back to keyboxes": "返回密钥盒列表",
  "Import keybox": "导入密钥盒",
  "Keybox file": "密钥盒文件",
  "Save as": "另存为",
  "Could not inspect this keybox.": "无法检查该密钥盒。",
  "Could not read that file.": "无法读取该文件。",
  "No keyboxes yet. Import an *.xml keybox to sign attestations with.":
    "还没有密钥盒。导入一个 *.xml 密钥盒即可用于签署认证。",
  "AOSP root": "AOSP 根",
  "AOSP software root": "AOSP 软件根",
  "Google root": "Google 根",
  "Knox root": "Knox 根",
  "Samsung Knox root": "Samsung Knox 根",
  "Unknown root": "未知根",
  "Signed by Google": "由 Google 签署",
  "Revoked by Google": "已被 Google 吊销",
  "Chain does not verify": "证书链校验未通过",
  "Chain does not root in a recognized attestation authority":
    "证书链未能链接到可识别的认证机构",
  REVOKED: "已吊销",
  " · not revoked": " · 未被吊销",
  " · revocation list unavailable": " · 吊销列表不可用",
  "Roots in the Google Hardware Attestation key": "链接到 Google 硬件认证密钥",
  "Roots in a Samsung Knox attestation key": "链接到 Samsung Knox 认证密钥",
  "A certificate in this chain is on Google's revocation list — attestations it signs are rejected by Play Integrity.":
    "该证书链中的某张证书已被列入 Google 吊销列表 —— 由它签署的认证会被 Play Integrity 拒绝。",
  "A certificate signature in this chain is invalid, so it is not a usable attestation chain.":
    "该证书链中某张证书的签名无效，因此这不是一条可用的认证链。",

  // ---- logs -----------------------------------------------------------------
  "Filter logs": "筛选日志",
  "Save logs": "保存日志",
  "Reset filters": "重置筛选",
  "Message contains": "消息包含",
  "Minimum level": "最低级别",
  Tags: "标签",
  "No tags seen yet.": "尚未看到任何标签。",
  Filename: "文件名",
  Folder: "文件夹",
  "Scroll to top": "滚动到顶部",
  "Scroll to bottom": "滚动到底部",
  "daemon unreachable": "守护进程不可达",

  // ---- system ---------------------------------------------------------------
  "Daemon health": "守护进程健康状态",
  Daemon: "守护进程",
  Harvest: "采集",
  Installed: "已安装",
  "Install failed": "安装失败",
  "Fabricated value saved — applying…": "已保存伪造值 —— 正在应用…",
  "Update flashed — reboot to apply.": "更新已刷入 —— 重启后生效。",
  "The daemon rejected the install.": "守护进程拒绝了本次安装。",
  "The daemon isn't responding yet.": "守护进程尚未响应。",
  "Daemon status endpoint unreachable.": "守护进程的状态接口不可达。",
  "Update status unavailable — daemon unreachable.": "无法获取更新状态 —— 守护进程不可达。",
  "Reading status…": "正在读取状态…",
  "Checking for updates…": "正在检查更新…",
  "Downloading & flashing…": "正在下载并刷入…",
  "Installing…": "正在安装…",
  "On the latest canary.": "已是最新的 canary。",
  "No canary release has been published yet.": "尚未发布任何 canary 版本。",
  "No release notes.": "没有发布说明。",
  "No harvest record yet.": "还没有采集记录。",
  "release page ↗": "发布页面 ↗",
  "What's new": "更新内容",
  Assets: "资源文件",
  "Build variant": "构建变体",
  Captured: "已采集",
  Fabricated: "已伪造",
  Failed: "失败",
  Verified: "已验证",
  Unverified: "未验证",
  // NOTE: the KeyMint assurance levels (Software / TrustedEnvironment / StrongBox), the root
  // kinds (SelfSigned / …) and the hook strategy (Hook / Interceptor) are identifiers from the
  // daemon, not copy — they are deliberately left verbatim so a row reads the same as logcat.
  unknown: "未知",
  "No key was attestable (common on certain models after unlocking the bootloader), so nothing was captured — every value below is synthesized.":
    "没有任何密钥可通过认证（某些机型解锁 bootloader 后很常见），因此没有采集到任何内容 —— 下面每个值都是合成的。",

  // ---- remote key provisioning ---------------------------------------------
  "Remote Key Provision": "远程密钥下发",
  "Enable rkpd": "启用 rkpd",
  "StrongBox RKP-only": "仅 StrongBox 走 RKP",
  "TEE RKP-only": "仅 TEE 走 RKP",
  "Whether the native remote key provisioning daemon (rkpd) runs on this device.":
    "本机是否运行原生的远程密钥下发守护进程（rkpd）。",
  "When on, the StrongBox security level provisions attestation keys only via RKP, with no batch-key fallback.":
    "开启后，StrongBox 安全级别仅通过 RKP 下发认证密钥，不再回退到批量密钥。",
  "When on, the TEE security level provisions attestation keys only via RKP, with no batch-key fallback.":
    "开启后，TEE 安全级别仅通过 RKP 下发认证密钥，不再回退到批量密钥。",
  "You usually don't need to change these.": "通常无需更改这些设置。",
  "The module handles remote provisioning while these stay on. Only if a device explicitly fails keybox attestation — a rare case — should you toggle them all off to force keystore2 onto the keybox.":
    "这些开关保持开启时，远程下发由模块处理。只有当某台设备明确无法通过密钥盒认证（罕见情况）时，才需要把它们全部关掉，以迫使 keystore2 走密钥盒。",

  // ---- USB debugging -------------------------------------------------------
  "USB debugging": "USB 调试",
  "Pin USB debugging": "固定 USB 调试状态",
  "Reading…": "读取中…",
  "Could not update USB debugging.": "无法更新 USB 调试状态。",
  "Written to a system property and re-applied at every boot, so turning USB debugging off keeps it off after a reboot — and leaving it on keeps it on.":
    "会写入系统属性，并在每次开机时重新应用：关闭后重启依旧是关闭状态，开启后同样保持开启。",

  // ---- identity fields (schema labels) -------------------------------------
  Apps: "应用",
  "Auto-include new apps": "自动包含新应用",
  "Operation mode": "运行模式",
  "Boot patch": "Boot 补丁级别",
  "System patch": "System 补丁级别",
  "Vendor patch": "Vendor 补丁级别",
  "OS version": "OS 版本",
  Brand: "品牌",
  Device: "设备",
  Manufacturer: "制造商",
  Model: "型号",
  Product: "产品",
  Serial: "序列号",
  IMEI: "IMEI",
  MEID: "MEID",
  "The apps this profile attests for.": "该配置文件为其进行认证的应用。",

  // ---- validation / IO messages --------------------------------------------
  "A keybox ending in .xml is required.": "需要一个以 .xml 结尾的密钥盒。",
  "At least one app is required (or turn on Auto-include new apps).":
    "至少需要一个应用（或开启“自动包含新应用”）。",
  "Config must be an object.": "配置必须是一个对象。",
  "Config.profiles must be an object.": "Config.profiles 必须是一个对象。",
  "Profile is not an object.": "配置文件不是一个对象。",
  "No config.json found (or it is empty).": "未找到 config.json（或内容为空）。",
  "Unsupported config version (expected 1).": "不支持的配置版本（应为 1）。",
  "config.json root must be a JSON object.": "config.json 的根节点必须是 JSON 对象。",
  "overrides.json root must be a JSON object.": "overrides.json 的根节点必须是 JSON 对象。",
  "Invalid current keybox name.": "当前密钥盒名称无效。",
  "Invalid keybox name.": "密钥盒名称无效。",
  "Invalid keybox name. Use letters, digits, . _ - and an .xml suffix.":
    "密钥盒名称无效。请使用字母、数字、. _ -，并以 .xml 结尾。",
  "Invalid new keybox name. Use letters, digits, . _ - and an .xml suffix.":
    "新密钥盒名称无效。请使用字母、数字、. _ -，并以 .xml 结尾。",
  "No keys deleted": "未删除任何密钥",
  "System UI": "系统 UI",
};

// Case-folded index over the dictionary, consulted only as a last resort: the validators
// lower-case a field label ("Invalid os version: 1.2.3.4"), and the same prose drifts between
// Title and Sentence case across views. Keys are unique modulo case (asserted by
// tests/i18n.test.mjs), so a folded hit is unambiguous — and it can only ever match a string the
// exact dictionary already covers, never a token it deliberately leaves alone.
const ZH_FOLDED = new Map();
for (const [k, v] of Object.entries(ZH)) {
  const folded = k.toLowerCase();
  if (!ZH_FOLDED.has(folded)) ZH_FOLDED.set(folded, v);
}

// --- rules for sentences built from variables --------------------------------
const RULES = [
  // ---- multi-line confirm dialogs ----
  [
    /^Target privileged uid (\d+)\?\n\nThis is a system\/shell uid \(e\.g\. shell, system_server\), not a normal app\. Only do this if you know exactly why\.$/,
    (m) =>
      `以特权 uid ${m[1]} 为目标？\n\n这是系统/shell 的 uid（例如 shell、system_server），并非普通应用。只有当完全清楚原因时才这样做。`,
  ],
  [
    /^This app is auto-included by profile “(.*)”\.\n\nPinning it here takes it out of that profile's automatic scope from the next rescan\.$/,
    (m) => `该应用由配置文件 “${m[1]}” 自动包含。\n\n在此处固定它，会让它从下次重新扫描起脱离该配置文件的自动作用域。`,
  ],
  [/^Remove profile "(.*)"\?$/, (m) => `删除配置文件 “${m[1]}”？`],
  [/^Overwrite existing keybox "(.*)"\?$/, (m) => `覆盖已存在的密钥盒 “${m[1]}”？`],
  [/^Rename "(.*)" to:$/, (m) => `将 “${m[1]}” 重命名为：`],
  [/^Delete keybox "(.*)"\? This cannot be undone\.$/, (m) => `删除密钥盒 “${m[1]}”？此操作无法撤销。`],
  [
    /^Install (.*)\? This downloads and flashes the module over the current install\.$/,
    (m) => `安装 ${m[1]}？这会下载模块并刷写到当前安装之上。`,
  ],
  [
    /^Delete (.+) from keystore2\? The owning app will re-create the key \(and re-attest it\) on next use\.$/,
    (m) => `从 keystore2 删除 ${m[1]}？所属应用会在下次使用时重新创建该密钥（并重新进行认证）。`,
  ],

  // ---- failure/success toasts (prefix + detail) ----
  [/^Clear failed: (.*)$/, "清除失败：$1"],
  [/^Rescan failed: (.*)$/, "重新扫描失败：$1"],
  [/^Save failed: (.*)$/, "保存失败：$1"],
  [/^Delete failed: (.*)$/, "删除失败：$1"],
  [/^Inspect failed: (.*)$/, "检查失败：$1"],
  [/^Import failed: (.*)$/, "导入失败：$1"],
  [/^Refresh failed: (.*)$/, "刷新失败：$1"],
  [/^Rename failed: (.*)$/, "重命名失败：$1"],
  [/^Install failed: (.*)$/, "安装失败：$1"],
  [/^Could not create config: (.*)$/, "无法创建配置：$1"],
  [/^Cannot read overrides\.json: (.*)$/, "无法读取 overrides.json：$1"],
  [/^config\.json is not valid JSON: (.*)$/, "config.json 不是合法的 JSON：$1"],
  [/^overrides\.json is not valid JSON: (.*)$/, "overrides.json 不是合法的 JSON：$1"],
  [/^Invalid app entry: (.*)$/, "无效的应用条目：$1"],
  [/^A profile named (.*) already exists\.$/, (m) => `已存在名为 “${m[1]}” 的配置文件。`],
  [/^A keybox named (.*) already exists\.$/, (m) => `已存在名为 “${m[1]}” 的密钥盒。`],
  [/^Imported (.*)$/, "已导入 $1"],
  [/^Renamed to (.*)$/, "已重命名为 $1"],
  [/^Saved (\d+) KB to (.*)$/, "已保存 $1 KB 到 $2"],
  [/^Saved to (.*)$/, "已保存到 $1"],
  [/^Rescanned — (\d+) apps? targeted$/, "已重新扫描 —— 已覆盖 $1 个应用"],
  [/^Deleted (\d+) keys?$/, "已删除 $1 个密钥"],
  [/^daemon unreachable — (.*)$/, "守护进程不可达 —— $1"],
  [/^daemon unreachable: (.*)$/, "守护进程不可达：$1"],

  // ---- validation messages (must stay in sync with tests/domain.test.mjs) ----
  [/^Invalid (.+): (.*)$/, (m) => `${t(capitalise(m[1]))}无效：${m[2]}`],
  [/^(.+) is required\.$/, (m) => `${t(capitalise(m[1]))}为必填项。`],
  [/^Unsupported version \(expected (\d+)\)\.$/, "不支持的版本（应为 $1）。"],
  [
    /^App entry (.*) is claimed by (\d+) profiles; it must be unique\.$/,
    "应用条目 $1 被 $2 个配置文件占用；它必须是唯一的。",
  ],
  [/^Only one profile may auto-include new apps; (\d+) do\.$/, "只允许一个配置文件自动包含新应用；目前有 $1 个。"],
  [/^(.+) is not valid JSON: (.*)$/, "$1 不是合法的 JSON：$2"],

  // ---- config editor composition ----
  [/^harvested → (.*)$/, "已采集 → $1"],
  [
    /^Leave a patch, OS, or identity field empty to use the value (.*)$/,
    (m) => `补丁级别、OS 或标识字段留空时，将使用${t(m[1])}`,
  ],
  [
    /^Auto-include on — (\d+) apps? installed since TEESimulator started (?:is|are) also in scope\.$/,
    "自动包含已开启 —— 自 TEESimulator 启动以来安装的 $1 个应用也在作用域内。",
  ],

  // ---- scope rows / chips ----
  [/^ · (\d+) auto$/, " · $1 个自动"],
  [
    /^(\d+) selected( · (\d+) auto)$/,
    (m) => `${m[1]} 已选 · ${m[3]} 个自动`,
  ],
  [/^(\d+) selected$/, "$1 已选"],
  [/^\+(\d+) more$/, "还有 $1 个"],
  [/^(.*) is not installed on this device$/, "$1 未安装在本设备上"],
  [/^(.*) is not installed \(a name-match applies if it installs later\)$/, "$1 未安装（若之后安装，将按名称匹配生效）"],
  [/^(.*) is not installed for (.*)$/, (m) => `${m[1]} 未安装（${userLabel(m[2])}）`],
  [/^Advanced: targets caller uid (.+)$/, "高级：以调用方 uid $1 为目标"],
  [/^Show only user (\d+)$/, "仅显示用户 $1"],
  [/^Installed for user (\d+)( \(work profile\))?$/, (m) => `已为用户 ${m[1]} 安装${m[2] ? "（工作资料）" : ""}`],
  [/^User (\d+)$/, "用户 $1"],
  [/^user (\d+)$/, "用户 $1"],
  [/^Show only user (.*)$/, "仅显示用户 $1"],
  [/^Installed for user (\d+)$/, "已为用户 $1 安装"],
  [/^Scope — (.*)$/, "作用域 —— $1"],
  [/^Already targeted by profile (.*)$/, "已被配置文件 $1 设为目标"],
  [
    /^In scope automatically — tap to pin it to (.*)\. To exclude it, turn off Auto-include new apps\.$/,
    "已在作用域内（自动）—— 点按可将其固定到 $1。若要排除它，请关闭“自动包含新应用”。",
  ],
  [
    /^Auto-included by profile (.*) — tap to pin it here instead\.$/,
    "由配置文件 $1 自动包含 —— 点按可改为固定到此处。",
  ],
  [/^Remove (.*)$/, "移除 $1"],
  [/^Used by profile “(.*)”$/, (m) => `被配置文件 “${m[1]}”使用`],
  [/^unknown keyAdmin action: (.*)$/, "未知的 keyAdmin 操作：$1"],
  [/^(\d+) key requests recorded$/, "记录了 $1 次密钥请求"],
  [/^No apps match “(.*)”\.$/, "没有匹配 “$1” 的应用。"],

  // ---- keys ----
  [/^(.*?)  \(Android API (\d+)\)$/, "$1（Android API $2）"],
  [/^(\d+) real device keys? hidden — switch to All to show them\.$/, "已隐藏 $1 个真实设备密钥 —— 切换到“全部”即可显示。"],
  [/^Delete selected \((\d+)\)$/, "删除所选（$1）"],
  [/^Clear filter (.*)$/, "清除筛选：$1"],
  [/^Filter by (.*)$/, "按 $1 筛选"],
  [/^No keys match “(.*)”\.$/, "没有匹配 “$1” 的密钥。"],
  [/^state (.*)$/, "状态 $1"],

  // ---- keybox inspection ----
  [/^Inspect (.*)$/, "检查 $1"],
  [
    /^(Roots in the Google Hardware Attestation key|Roots in a Samsung Knox attestation key)( · .*)?\.$/,
    (m) => `${t(m[1])}${m[2] ? t(m[2]) : ""}。`,
  ],
  [/^ (· (?:not revoked|revocation list unavailable))\.$/, " · 未吊销。"],

  // ---- system ----
  [/^Flashes (.*) over the current module, then reboot to apply\.$/, "会把 $1 刷写到当前模块之上，重启后生效。"],
  [/^build (.*)$/, "构建 $1"],
  [/^(\d+) apps? targeted$/, "已覆盖 $1 个应用"],
];
