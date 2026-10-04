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

while true; do
  "$MODDIR/daemon" "$MODDIR"
  sleep 2
done &
