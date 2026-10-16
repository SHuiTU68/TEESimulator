// The pure half of the USB-debugging pin: what the module's recorded choice means for the device's
// USB function list. No DOM, no bridge, no I/O — so it is unit-testable, and so the WebUI and
// module/service.sh's boot re-assertion implement ONE rule.
//
// The model, end to end:
//   * persist.teesim.usb_debug ("1"/"0") is the module's RECORD of the user's choice. It is a
//     persist.* property, so it survives a reboot on its own; module/service.sh re-asserts the
//     choice it describes on every boot.
//   * Settings.Global.adb_enabled is Android's own USB-debugging toggle. The framework adds or
//     removes the "adb" USB function from it, and re-derives the live USB configuration at boot.
//   * persist.sys.usb.config is the persisted USB function list. The pin drives it to a FIXED value
//     derived from the record alone — on -> "mtp,adb" (file transfer + debugging), off -> "none"
//     (charging only) — and never leaves it at whatever the framework would otherwise fall back to.
//     That fixed write is what stops a boot from silently putting the device back on "mtp".
//
// Nothing here touches the shell: it is string math over those values.

export const ADB = "adb";
// The function list the pin puts on the device. On, debugging rides alongside file transfer; off,
// the device is charging-only ("none") rather than left advertising MTP.
export const ON_FUNCTIONS = "mtp,adb";
export const OFF_FUNCTIONS = "none";

// The USB function list the pin maps to. Derived from the record alone, so the WebUI and
// module/service.sh agree without either having to inspect the device's current list.
export function functionsFor(on) {
  return on ? ON_FUNCTIONS : OFF_FUNCTIONS;
}

// True when a comma-separated USB function list contains the adb function.
export function hasAdb(config) {
  return splitFunctions(config).includes(ADB);
}

// The switch's state from the two properties: the record wins, and only when it is absent (a fresh
// install, or a device where the write failed) do we fall back to what the device's own USB
// function list says. `pinned` tells the view whether the module is managing this at all.
export function usbDebugState(pin, config) {
  const p = String(pin == null ? "" : pin).trim().toLowerCase();
  const pinned = p === "1" || p === "0" || p === "true" || p === "false";
  const on = pinned ? (p === "1" || p === "true") : hasAdb(config);
  return { on, pinned };
}

function splitFunctions(config) {
  return String(config == null ? "" : config)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}
