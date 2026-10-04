// Owns the System screen: the read-only daemon/harvest status poll, the USB-debugging pin, the
// boot-property hiding list, and the canary updater. Nothing here reaches the shell except through
// the daemon seam (data/status.js and data/keyadmin.js) or one of the two device-level adapters
// (data/usb-io.js for the pin, data/hide-props-io.js for hide_props.conf). It degrades gracefully —
// an unreachable daemon yields a well-formed "unreachable" health snapshot and simply no update
// badge, and an unreadable property or property list yields a card that says so, never a thrown
// error.
//
// create(mount, { onHealth, onBadge })
//   onHealth(status)  report the latest health snapshot up to the top-bar pill
//   onBadge(bool)     report whether a canary update is available, for the nav dot
// Exposes { load, boot }: load() is called when the screen is shown; boot() runs
// the one-shot probes at startup so the pill and badge are seeded before the user
// ever opens this screen.

import { getStatus } from "../data/status.js";
import { keyAdmin } from "../data/keyadmin.js";
import * as overridesIo from "../data/overrides-io.js";
import { readUsbDebug, setUsbDebug } from "../data/usb-io.js";
import { HIDE_PROPS, loadHideProps, saveHideProps } from "../data/hide-props-io.js";
import { renderSystem, refreshHealth as patchHealthCards } from "../ui/system-view.js";
import { toast, confirmDialog } from "../ui/dom.js";

const POLL_MS = 5000;
// How long to wait after writing overrides.json before re-reading status: the daemon's DATA_DIR watcher
// re-merges and re-pushes, then /status reflects the new override layer. The 5 s poll is the backstop.
const OVERRIDE_SETTLE_MS = 600;

export function create(mount, opts = {}) {
  const onHealth = opts.onHealth || (() => {});
  const onBadge = opts.onBadge || (() => {});

  let status = null;
  let update = null;      // canary probe result, or null when unreachable/unprobed
  let probed = false;     // has the canary probe resolved at least once?
  let canarySig = null;   // serialized `update` at last paint, to skip no-op re-renders
  let variant = "release";
  let installing = false;
  let installError = null;
  let notesOpen = false;
  let usb = null;         // the USB-debug pin: { on, pinned, pin, config, … }, or null when unreadable
  let props = null;       // hide_props.conf: { text, path }, or { error } when it could not be read

  let timer = null;
  let inFlight = false;

  // What the Update card is a function of: the probe result AND whether it has
  // resolved yet (probed flips its "Checking…" vs "unavailable" copy). The periodic
  // health poll must not rebuild that card, so probeCanary re-renders only when this
  // signature changes.
  const canarySignature = () => JSON.stringify({ probed, update });

  function render() {
    renderSystem(mount, { status, update, probed, variant, installing, installError, notesOpen, usb, props }, actions);
    canarySig = canarySignature();
  }

  // The USB-debug pin's state is a function of two system properties, so it is read once when the
  // screen is shown and after every flip — never on the health poll (it cannot change by itself).
  async function refreshUsb() {
    usb = await readUsbDebug();
    render();
  }

  // The boot-property list is one file, so it is read when the screen is shown and after every save,
  // and never on the health poll — nothing else can change it under us. An unreadable file becomes
  // { error } rather than an empty box, which would read as "nothing is hidden".
  async function refreshProps() {
    const res = await loadHideProps();
    props = res.ok ? { text: res.text, path: HIDE_PROPS } : { error: res.error };
    render();
  }

  // Health snapshot: never throws (getStatus returns an "unreachable" object), so
  // the pill always gets a truthful state. Patches ONLY the health + harvest cards so
  // the periodic 5 s poll never tears down the interactive Update card; if the screen
  // hasn't been fully painted yet (probed on boot), fall back to a full render.
  async function refreshHealth() {
    if (inFlight) return; // don't stack probes if one is slow
    inFlight = true;
    try {
      status = await getStatus();
      onHealth(status);
    } finally {
      inFlight = false;
    }
    if (!patchHealthCards(mount, status, actions)) render();
  }

  // Persist one override edit to overrides.json, then let the daemon re-merge and re-push before we
  // re-read status. Writing an empty value (or reset) removes the key so the field falls back to the
  // daemon's computed default. Never throws to the view — surfaces failures as a toast.
  async function writeOverride(field, value) {
    const cur = await overridesIo.load();
    if (!cur.ok) { toast("Cannot read overrides.json: " + cur.error); return; }
    const next = { ...cur.overrides };
    if (value == null || value === "") delete next[field];
    else next[field] = value;
    const res = await overridesIo.save(next);
    if (!res.ok) { toast("Save failed: " + res.error); return; }
    toast("Fabricated value saved — applying…");
    await new Promise((r) => setTimeout(r, OVERRIDE_SETTLE_MS));
    await refreshHealth();
  }

  // Canary probe: sets the update state and the nav badge. A daemon that is down or
  // has no canary endpoint yet leaves update=null and clears the badge — silent.
  // Re-renders only when the probe result actually changed, so a repeat probe that
  // returns the same thing doesn't rebuild the Update card.
  async function probeCanary() {
    let next = null;
    try {
      const res = await keyAdmin("canary");
      next = res && res.ok !== false ? res : null;
    } catch {
      next = null;
    }
    update = next;
    probed = true;
    onBadge(!!(update && update.updateAvailable));
    if (canarySignature() !== canarySig) render();
  }

  const actions = {
    // Harvest override edits (System screen "Overrides" group). Both write overrides.json and refresh.
    onSaveOverride(field, value) { writeOverride(field, value); },
    onResetOverride(field) { writeOverride(field, ""); },

    // Pin USB debugging on or off. The switch is its own feedback, so there is no toast on success;
    // on failure the re-read below snaps it back to the value the device actually took, and the
    // toast says why. This is the one place where "nothing happened" would be invisible otherwise.
    async onToggleUsbDebug(on) {
      const res = await setUsbDebug(on);
      if (res && res.ok === false) toast("Could not update USB debugging.");
      usb = await readUsbDebug();
      render();
    },

    // Persist the property list. Blank text removes the file, which both appliers read exactly like
    // an empty one ("nothing hidden"); the daemon's DATA_DIR watcher re-reconciles the boot properties
    // the moment it lands, so the re-read below shows what the device will actually parse.
    async onSaveProps(text) {
      const res = await saveHideProps(text);
      if (res && res.ok === false) { toast("Save failed: " + res.error); return; }
      toast("Saved");
      await refreshProps();
    },

    onSelectVariant(v) {
      if (v === variant) return;
      variant = v;
      render();
    },

    onToggleNotes() {
      notesOpen = !notesOpen;
      render();
    },

    async onInstall() {
      const latest = update && update.latest;
      if (!latest || !update.updateAvailable || installing) return;
      const label = "canary-" + (latest.code || "?") + " (" + variant + ")";
      if (!(await confirmDialog(`Install ${label}? This downloads and flashes the module over the current install.`, { confirmLabel: "Install", danger: false }))) return;

      installing = true;
      installError = null;
      render();
      try {
        const res = await keyAdmin("canaryInstall", { tag: latest.tag, variant });
        if (res && res.ok === false) {
          installError = res.message || "The daemon rejected the install.";
          toast("Install failed");
        } else {
          toast((res && res.message) || "Update flashed — reboot to apply.");
        }
      } catch (e) {
        installError = e && e.message ? e.message : String(e);
        toast("Install failed: " + installError);
      } finally {
        installing = false;
        render();
      }
    },
  };

  // Poll health only while the screen is on-screen and the app is foreground, so a
  // hidden panel costs nothing. Canary is not polled — it's checked on boot/load.
  function visible() {
    return mount.offsetParent !== null && document.visibilityState === "visible";
  }
  function startPolling() {
    if (timer) return;
    timer = setInterval(() => { if (visible()) refreshHealth(); }, POLL_MS);
  }

  return {
    // One-shot probes at app startup: seed the pill and the badge without showing
    // this screen. Fire-and-forget; both degrade silently.
    boot() {
      refreshHealth();
      probeCanary();
    },

    load() {
      render();            // paint the last snapshot instantly
      startPolling();
      refreshHealth();
      probeCanary();
      refreshUsb();        // the pin's two properties, read once per visit
      refreshProps();      // the boot-property list, read once per visit
    },
  };
}
