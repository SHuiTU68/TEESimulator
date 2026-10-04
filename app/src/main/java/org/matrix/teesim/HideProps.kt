package org.matrix.teesim

/**
 * The `hide_props.conf` reader: the user's per-property control over the boot-state reconciliation.
 *
 * The file is a plain list of lines, one property each:
 *
 * ```text
 * # comments run to the end of the line
 * sys.oem_unlock_allowed     # a bare name DELETES the property
 * ro.boot.flash.locked=1     # name=value OVERRIDES it
 * ```
 *
 * A property that is not listed is still synced to the value derived from the boot state we attest
 * — the list only ever takes a property away or pins it, it never disables the reconciliation for
 * everything else.
 *
 * The SAME syntax is implemented twice on purpose: here (so a change wins over the derived value on
 * the next push, which the WebUI's save trips through the DATA_DIR watcher) and in
 * `module/service.sh` (so the list still applies when the daemon never gets to run). The two must
 * agree line for line; the JVM side is covered by the WebUI's own domain tests, which parse the
 * same grammar.
 */
object HideProps {

    /** What the user asked for a given property: hide it, or pin it to a value. */
    sealed class Directive {
        object Delete : Directive()

        data class Override(val value: String) : Directive()
    }

    /**
     * The directive for [name], or null when the property is not listed. Re-read on every call
     * rather than cached: the file is a few lines, and the whole point of the WebUI's save path is
     * that the next push picks the edit up immediately. A missing or unreadable file yields an empty
     * map, i.e. "the user has asked for nothing" — never an error.
     */
    fun directive(name: String): Directive? = directives()[name]

    /**
     * The whole file as directives, for [App], which applies the lines naming a property it does not
     * itself reconcile — a line is honoured here exactly as `module/service.sh` honours it on boot.
     */
    fun directives(): Map<String, Directive> =
        try {
            val file = Const.hidePropsFile
            if (!file.isFile) emptyMap() else parse(file.readText())
        } catch (e: Exception) {
            SystemLogger.warning("HideProps: could not read ${Const.hidePropsFile}: ${e.message}")
            emptyMap()
        }

    /** The whole file as directives. Later lines win, as in the shell applier's left-to-right run. */
    fun parse(content: String): Map<String, Directive> {
        val map = LinkedHashMap<String, Directive>()
        for (raw in content.lineSequence()) {
            // A comment runs to the end of the line, and all whitespace is insignificant: the list
            // is a list of names, so `ro.boot.flash.locked = 1` and `ro.boot.flash.locked=1` mean the
            // same thing and a name can never pick up a stray space.
            val line = raw.substringBefore('#').filterNot { it.isWhitespace() }
            if (line.isEmpty()) continue
            val eq = line.indexOf('=')
            if (eq < 0) {
                map[line] = Directive.Delete
                continue
            }
            val name = line.substring(0, eq)
            val value = line.substring(eq + 1)
            // A half-written line (`=1`, `prop=`) pins nothing and hides nothing — exactly the shell
            // applier's behaviour, where `resetprop -n` with an empty value is not what was meant.
            if (name.isEmpty() || value.isEmpty()) continue
            map[name] = Directive.Override(value)
        }
        return map
    }
}
