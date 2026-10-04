// The pure half of the USB-debugging pin: how the module's recorded choice and the device's USB
// function list map onto one another. No DOM, no bridge, no I/O — so it is unit-testable, and so
// the WebUI and module/service.sh's boot re-assertion implement ONE rule.
//
// The model, end to end:
//   * persist.teesim.usb_debug ("1"/"0") is the module's RECORD of the user's choice. It is a
//     persist.* property, so it survives a reboot on its own; module/service.sh re-asserts the
//     choice it describes on every boot.
//   * Settings.Global.adb_enabled is Android's own USB-debugging toggle. The framework adds or
//     removes the "adb" USB function from it, and re-derives the live USB configuration at boot.
//   * persist.sys.usb.config is the persisted USB function list ("mtp", "mtp,adb", …). Keeping
//     "adb" in or out of it makes the function list agree with the record even on a device where
//     the settings write is refused.
//
// Nothing here touches the shell: it is string math over those values.

export const ADB = "adb";
// What a device without a usable function list gets instead of "adb" alone: expose MTP, which is
// what a phone does by default, rather than a USB configuration that only serves debugging.
export const DEFAULT_FUNCTIONS = "mtp";

// True when a comma-separated USB function list contains the adb function.
export function hasAdb(config) {
  return splitFunctions(config).includes(ADB);
}

// The same list with adb added or removed. Order and every other function are preserved, so
// pinning USB debugging never silently changes whether the device also exposes MTP/PTP/RNDIS.
export function withAdb(config, on) {
  const fns = splitFunctions(config).filter((f) => f !== ADB);
  if (!fns.length) fns.push(DEFAULT_FUNCTIONS);
  if (on) fns.push(ADB);
  return fns.join(",");
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
