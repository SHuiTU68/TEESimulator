#!/system/bin/sh
# Started late at boot. The Kotlin control daemon does the real work — it harvests
# the device's attestation parameters, resolves config.json into per-profile
# settings, injects the interceptor into keystore/keystore2, and pushes the resolved
# config over the control socket, re-injecting and re-pushing as things change. This
# script only launches the daemon and respawns it if it ever exits.
MODDIR=${0%/*}

# admin.token is the WebUI's key-management credential; keep it root-only. The whole data dir holds
# the token and the admin socket, so keep it 0700 too — the socket is then unreachable to other apps.
chmod 0700 /data/adb/teesim 2>/dev/null
chmod 0600 /data/adb/teesim/admin.token 2>/dev/null

# Stage the WebUI's admin-socket client at a fixed, root-only path, so the WebUI can invoke it without
# knowing the module's runtime path or the device ABI. Only the device's own ABI dir survives install,
# so the glob matches one file; refreshed every boot so a module update always stages the current one.
for f in "$MODDIR"/*/teesim-uds; do
  if [ -f "$f" ]; then
    cp "$f" /data/adb/teesim/teesim-uds && chmod 0700 /data/adb/teesim/teesim-uds
    break
  fi
done

# --- USB-debugging pin -------------------------------------------------------
# The WebUI's USB-debugging switch records the user's choice in persist.teesim.usb_debug
# (1 = on, 0 = off). A persist.* property survives a reboot by itself, but the framework
# re-derives the live USB configuration while it boots, so the recorded choice is re-asserted
# here: the settings write is the one Android applies through its normal path, and the
# function-list write below keeps persist.sys.usb.config agreeing with the record even on a
# device that refuses the settings write. Silent when the pin is unset — a device that has
# never used the switch keeps whatever it had.
pin=$(getprop persist.teesim.usb_debug)
case "$pin" in
  0 | 1)
    if [ "$pin" = "1" ]; then
      settings put global adb_enabled 1 2>/dev/null
    else
      settings put global adb_enabled 0 2>/dev/null
    fi
    cfg=$(getprop persist.sys.usb.config)
    [ -n "$cfg" ] || cfg=mtp
    rest=""
    OLDIFS=$IFS
    IFS=,
    for f in $cfg; do
      if [ "$f" != "adb" ] && [ -n "$f" ]; then
        if [ -z "$rest" ]; then rest=$f; else rest="$rest,$f"; fi
      fi
    done
    IFS=$OLDIFS
    [ -n "$rest" ] || rest=mtp
    if [ "$pin" = "1" ]; then
      new="$rest,adb"
    else
      new=$rest
    fi
    if [ "$new" != "$cfg" ]; then
      resetprop persist.sys.usb.config "$new" 2>/dev/null ||
        setprop persist.sys.usb.config "$new" 2>/dev/null
    fi
    ;;
esac

# --- system-property hiding (hide_props.conf) --------------------------------
# Per-property control over the boot-state properties the daemon reconciles on every push. One entry
# per line: a bare property name DELETES it, "name=value" OVERRIDES it. A '#' starts a comment that
# runs to the end of the line, and whitespace is insignificant. A property that is not listed is
# still synced to the value derived from the locked/Verified boot state we attest — the list only
# ever takes a property away or pins it.
#
# The daemon honours the same file, line for line (HideProps.kt), so an edit made in the WebUI is
# picked up on the next push without a reboot; this copy is here so the list also applies when the
# daemon never gets to run. Both read the one file, so the two can never disagree. Silent when absent.
HIDE_PROPS=/data/adb/teesim/hide_props.conf
if [ -f "$HIDE_PROPS" ]; then
  # resetprop is the manager's binary; MAGISK, KernelSU and APatch each keep it somewhere different.
  RP=""
  for c in /system_ext/bin/resetprop /system/bin/resetprop /data/adb/ksu/bin/resetprop /data/adb/magisk/resetprop; do
    if [ -x "$c" ]; then
      RP=$c
      break
    fi
  done
  [ -n "$RP" ] || RP=$(command -v resetprop 2>/dev/null)
  if [ -n "$RP" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%%#*}
      # Whitespace is insignificant, so "ro.boot.flash.locked = 1" reads like "ro.boot.flash.locked=1".
      line=$(printf '%s' "$line" | tr -d '[:space:]')
      [ -n "$line" ] || continue
      case "$line" in
        *=*)
          # A half-written line ("=1", "prop=") pins nothing and hides nothing, so skip it rather
          # than write an empty value.
          name=${line%%=*}
          value=${line#*=}
          [ -n "$name" ] && [ -n "$value" ] || continue
          "$RP" -n "$name" "$value" >/dev/null 2>&1
          ;;
        *)
          "$RP" -d "$line" >/dev/null 2>&1
          ;;
      esac
    done < "$HIDE_PROPS"
  fi
fi

while true; do
  "$MODDIR/daemon" "$MODDIR"
  sleep 2
done &
