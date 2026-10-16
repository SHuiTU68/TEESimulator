// Pure, DOM-free validators driven entirely off the schema. Every error is hard
// (it blocks Save); there is no warnings tier. Exercised directly by
// tests/domain.test.mjs, which is why nothing here touches the DOM or the bridge.

import {
  FIELDS, KEYBOX_RE, APP_ENTRY_RE, PROFILE_RE, VERSION,
} from "./schema.js";
import { getPath } from "./path.js";

// Validate one profile in isolation (no cross-profile knowledge here).
// Returns an array of { field, msg }; field matches a descriptor.key, or the
// synthetic "__name" for the profile name itself.
export function validateProfile(name, profile) {
  const errors = [];

  if (!PROFILE_RE.test(name)) {
    errors.push({ field: "__name", msg: "Name must be 1-32 chars: letters, digits, - or _." });
  }
  if (!profile || typeof profile !== "object") {
    errors.push({ field: "__name", msg: "Profile is not an object." });
    return errors;
  }

  for (const f of FIELDS) {
    const value = getPath(profile, f.path);

    if (f.type === "applist" || f.type === "scope") {
      const apps = Array.isArray(value) ? value : [];
      // "At least one app" no longer holds when auto-include covers the profile: an empty
      // apps list is fine precisely when autoIncludeNewApps is on (the daemon then targets
      // every unclaimed user app, so there is nothing to hand-pick).
      const autoIncludes = profile.autoIncludeNewApps === true;
      if (f.required && apps.length < 1 && !autoIncludes) {
        errors.push({ field: f.key, msg: "At least one app is required (or turn on Auto-include new apps)." });
      }
      // Each entry is a package name, a package@user name, OR a raw uid: token (APP_ENTRY_RE),
      // not package-only.
      for (const entry of apps) {
        if (typeof entry !== "string" || !APP_ENTRY_RE.test(entry)) {
          errors.push({ field: f.key, msg: `Invalid app entry: ${entry}` });
        }
      }
      continue;
    }

    if (f.key === "keybox") {
      if (!value || !KEYBOX_RE.test(value)) {
        errors.push({ field: f.key, msg: "A keybox ending in .xml is required." });
      }
      continue;
    }

    // A toggle carries a boolean, not a string, so it is never format-checked (its regex-less
    // descriptor already skips the scalar branch below, but guard explicitly so a future
    // required/re on a non-string type can't misfire against the empty-string check).
    if (f.type === "toggle") continue;

    // Generic scalar. Format is checked only when a value is present, so an
    // optional field left blank is fine; presence is a separate, explicit flag.
    if (f.re && value !== undefined && value !== "" && !f.re.test(value)) {
      errors.push({ field: f.key, msg: `Invalid ${f.label.toLowerCase()}: ${value}` });
    }
    if (f.required && (value === undefined || value === "")) {
      errors.push({ field: f.key, msg: `${f.label} is required.` });
    }
  }

  return errors;
}

// Validate the whole config, including the rules no single profile can see: a package may appear
// in at most one profile (routing is package -> one profile), and — when the caller hands in the
// keybox files actually present — that each profile's keybox points at a file that exists.
// Returns { ok, errors: [{ profile, field, msg }] }.
//
// `presentKeyboxes` is the list of *.xml basenames under /data/adb/teesim, or omitted/undefined when
// the caller cannot enumerate them (then the existence rule simply does not apply). It is a separate
// argument rather than a field on `config` because the field is a disk fact the validator cannot
// derive from the config object alone.
export function validateConfig(config, presentKeyboxes) {
  const errors = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: [{ profile: null, field: null, msg: "Config must be an object." }] };
  }
  if (config.version !== VERSION) {
    errors.push({ profile: null, field: null, msg: `Unsupported version (expected ${VERSION}).` });
  }
  const profiles = config.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    errors.push({ profile: null, field: null, msg: "Config.profiles must be an object." });
    return { ok: errors.length === 0, errors };
  }

  // Per-profile checks. A keybox that is named but not on disk is a hard error here too: the daemon
  // would skip that profile (or refuse the whole config when it is the only one) and surface it as an
  // opaque "no valid config to push", so blocking Save with the import hinted is strictly clearer.
  const present = Array.isArray(presentKeyboxes) ? new Set(presentKeyboxes) : null;
  for (const name of Object.keys(profiles)) {
    for (const e of validateProfile(name, profiles[name])) {
      errors.push({ profile: name, field: e.field, msg: e.msg });
    }
    const kb = profiles[name] && profiles[name].keybox;
    if (present && typeof kb === "string" && KEYBOX_RE.test(kb) && !present.has(kb)) {
      errors.push({
        profile: name, field: "keybox",
        msg: `Keybox ${kb} is not in /data/adb/teesim — import it first.`,
      });
    }
  }

  // Cross-profile: which profiles claim each package? Dedup within a profile
  // first (new Set) so a package listed twice in ONE profile is a single claim,
  // not a false cross-profile duplicate.
  const owners = new Map(); // pkg -> [profileName, ...] (distinct profiles)
  for (const name of Object.keys(profiles)) {
    const apps = Array.isArray(profiles[name] && profiles[name].apps) ? profiles[name].apps : [];
    for (const pkg of new Set(apps)) {
      if (!owners.has(pkg)) owners.set(pkg, []);
      owners.get(pkg).push(name);
    }
  }
  for (const [pkg, claimants] of owners) {
    if (claimants.length > 1) {
      for (const name of claimants) {
        errors.push({
          profile: name, field: "apps",
          msg: `App entry ${pkg} is claimed by ${claimants.length} profiles; it must be unique.`,
        });
      }
    }
  }

  // Auto-include is a whole-device catch-all ("every unclaimed user app"), so two profiles
  // both asking for it would fight over the same apps — the daemon allows at most one. Flag
  // every offender so the user sees exactly which profiles to reconcile.
  const autoProfiles = Object.keys(profiles).filter(
    (name) => profiles[name] && profiles[name].autoIncludeNewApps === true);
  if (autoProfiles.length > 1) {
    for (const name of autoProfiles) {
      errors.push({
        profile: name, field: "autoIncludeNewApps",
        msg: `Only one profile may auto-include new apps; ${autoProfiles.length} do.`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}
