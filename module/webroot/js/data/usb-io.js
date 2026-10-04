// The USB-debugging pin's transport: the privileged writes behind the System screen's switch.
// Property names are fixed literals, never derived from user input; only the boolean the user
// toggles reaches the shell, as canonical "1"/"0". The model — and why one flip is three writes —
// is documented in domain/usb.js. Every write goes through bridge/shell.js, the quoting boundary.

import { getProp, run, setProp } from "../bridge/shell.js";
import { usbDebugState, withAdb } from "../domain/usb.js";

// The module's record of the choice, and the device's persisted USB function list.
export const USB_DEBUG_PROP = "persist.teesim.usb_debug";
export const USB_CONFIG_PROP = "persist.sys.usb.config";

// `settings put global adb_enabled N` — the framework's own toggle, i.e. the same thing Developer
// options flips (a root shell passes SettingsProvider's permission check). Best-effort: on a device
// that refuses it, the function-list write below still carries the choice.
const SETTINGS = ["settings", "put", "global", "adb_enabled"];

// The USB function list the device currently persists; the live sys.usb.config is the fallback for
// a device that has never written the persist one.
async function currentFunctions() {
  return (await getProp(USB_CONFIG_PROP)) || (await getProp("sys.usb.config"));
}

// The state the switch renders, plus the raw property values it displays. Null when the read
// itself failed (no root shell / no bridge), which the view shows as "unavailable" rather than as
// a switch that would do nothing.
export async function readUsbDebug() {
  try {
    const pin = await getProp(USB_DEBUG_PROP);
    const config = await currentFunctions();
    return {
      ...usbDebugState(pin, config),
      pin,
      config,
      prop: USB_DEBUG_PROP,
      configProp: USB_CONFIG_PROP,
    };
  } catch (e) {
    console.error("[usb]", e);
    return null;
  }
}

// Flip the pin: record the choice, tell the framework, and keep the persisted function list in
// step. The RECORD is what makes the choice survive a reboot (module/service.sh re-reads it), so it
// is the one write whose failure is reported back — a failed record must not look like success.
export async function setUsbDebug(on) {
  const record = await setProp(USB_DEBUG_PROP, on ? "1" : "0");
  const config = await currentFunctions();
  await run([...SETTINGS, on ? "1" : "0"]);
  const next = withAdb(config, on);
  if (next !== config) await setProp(USB_CONFIG_PROP, next);
  return record.ok ? { ok: true } : { ok: false, error: record.error };
}
