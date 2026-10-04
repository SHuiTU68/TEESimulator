package org.matrix.teesim

/**
 * Best-effort setter/deleter for a system property a plain `setprop` cannot touch. Plain `setprop`
 * cannot write `ro.*`, so this shells out to Magisk's `resetprop -n` (the `-n` skips re-triggering
 * property_service, which is what lets a read-only prop be overwritten), and to `resetprop -d` when
 * a property has to stop EXISTING rather than hold a value. Used to keep the visible system state
 * consistent for integrity readers: the matching `ro.boot.vbmeta.*` property reflects the spoofed
 * boot key/hash, the boot-state properties are reconciled to the locked/Verified state we attest,
 * and a property listed for hiding in `hide_props.conf` is removed.
 *
 * Never throws — a device without resetprop just leaves the property as-is, logged. The daemon's own
 * attestation does not depend on these props (it uses the pushed config); this only keeps the
 * visible system state consistent for other integrity readers.
 */
object SysProp {
    /**
     * Overwrite [name] with [value] via the first resetprop invocation that succeeds. Returns
     * whether any candidate reported success. Idempotent — safe to call on every push.
     */
    fun set(name: String, value: String): Boolean =
        run(
            name,
            listOf(
                listOf("resetprop", "-n", name, value),
                listOf("magisk", "resetprop", "-n", name, value),
            ),
        )

    /**
     * Remove [name] entirely. For a property whose mere EXISTENCE is the signal being detected — an
     * integrity checker that flags `sys.oem_unlock_allowed` on Android 16+ does so whatever its value
     * — writing a benign value is not enough; the property has to stop existing. Idempotent: deleting
     * an absent property counts as success for the caller.
     */
    fun delete(name: String): Boolean =
        run(
            name,
            listOf(
                listOf("resetprop", "-d", name),
                listOf("magisk", "resetprop", "-d", name),
            ),
        )

    /** Try each candidate argv in order; the first exit-0 wins. Logs and returns false if none does. */
    private fun run(name: String, candidates: List<List<String>>): Boolean {
        for (cmd in candidates) {
            try {
                val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
                val out = p.inputStream.bufferedReader().readText().trim()
                val code = p.waitFor()
                if (code == 0) {
                    SystemLogger.info("SysProp: ${cmd[1]} $name via '${cmd.first()}'")
                    return true
                }
                SystemLogger.info(
                    "SysProp: '${cmd.first()}' exited $code for $name${if (out.isEmpty()) "" else " ($out)"}"
                )
            } catch (e: Exception) {
                SystemLogger.info(
                    "SysProp: '${cmd.first()}' unavailable: ${e.javaClass.simpleName}: ${e.message}"
                )
            }
        }
        SystemLogger.warning("SysProp: could not touch $name (no working resetprop)")
        return false
    }
}
