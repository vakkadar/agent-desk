// Profiles: which parts of the desk a person gets.
//   everyday  — Ask, General, Notes, History, Web (+ Usage under Settings)
//   developer — also Design and Code threads, the terminal, herdr sessions
//   admin     — developer, plus the desk's own code (Desk dev source, self_dev) and Compute
//               (machines and hosting accounts: power, ssh, Hostinger/GoDaddy API)
// desk.toml: `profile = "everyday"` (default), `guest_profile` (tunnel logins that are
// neither owners nor listed; default everyday) and `[profile_by_email]` for one login.
// The server enforces it (refuses those actions), the page only hides what it can't use.

export type Feature = "design" | "code" | "terminal" | "sessions" | "self" | "compute";
export type Profile = "everyday" | "developer" | "admin";

export const PROFILES: Record<Profile, Feature[]> = {
  everyday: [],
  developer: ["design", "code", "terminal", "sessions"],
  admin: ["design", "code", "terminal", "sessions", "self", "compute"],
};

export const isProfile = (p: unknown): p is Profile => typeof p === "string" && p in PROFILES;

export interface ProfileConfig {
  profile: Profile;
  guest: Profile; // tunnel logins that are not owners and not in byEmail
  byEmail: Record<string, Profile>;
  guestAsk: boolean; // read-only connections may ask browser-side targets in General
}

export function parseProfiles(raw: any): ProfileConfig {
  const profile = raw.profile === undefined ? "everyday" : raw.profile;
  if (!isProfile(profile)) throw new Error(`profile must be one of ${Object.keys(PROFILES).join(", ")} (got ${JSON.stringify(raw.profile)})`);
  const guest = raw.guest_profile === undefined ? "everyday" : raw.guest_profile;
  if (!isProfile(guest)) throw new Error(`guest_profile must be one of ${Object.keys(PROFILES).join(", ")} (got ${JSON.stringify(raw.guest_profile)})`);
  const byEmail: Record<string, Profile> = {};
  for (const [email, p] of Object.entries(raw.profile_by_email ?? {})) {
    if (!isProfile(p)) throw new Error(`profile_by_email."${email}" must be one of ${Object.keys(PROFILES).join(", ")}`);
    byEmail[email.toLowerCase()] = p;
  }
  return { profile, guest, byEmail, guestAsk: raw.guest_ask === true };
}

/** Profile for a connection: its Access email's own, else guest_profile for a guest, else the desk default. */
export function profileFor(cfg: ProfileConfig, email?: string | null, guest = false): Profile {
  return (email && cfg.byEmail[email.toLowerCase()]) || (guest ? cfg.guest : cfg.profile);
}

export const featuresOf = (p: Profile) => new Set<Feature>(PROFILES[p]);

/** Throws when the profile doesn't include the feature an action needs. */
export function needFeature(features: Set<Feature>, f: Feature): void {
  if (!features.has(f)) throw new Error(f === "self" ? "the desk's own code is for the admin profile only" : f === "compute" ? "Compute is for the admin profile only" : `${f} is not part of your profile (developer profile needed)`);
}
