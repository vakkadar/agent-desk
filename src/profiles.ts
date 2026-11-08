// Profiles: which parts of the desk a person gets.
//   everyday  — Ask, General, Notes, History, Web (+ Usage under Settings)
//   developer — everything: also Design and Code threads, the terminal, herdr sessions
// desk.toml: `profile = "everyday"` (default for everyone) and
// `[profile_by_email]` to give a Cloudflare Access login a different one.
// The server enforces it (refuses those actions), the page only hides what it can't use.

export type Feature = "design" | "code" | "terminal" | "sessions";
export type Profile = "everyday" | "developer";

export const PROFILES: Record<Profile, Feature[]> = {
  everyday: [],
  developer: ["design", "code", "terminal", "sessions"],
};

export const isProfile = (p: unknown): p is Profile => typeof p === "string" && p in PROFILES;

export interface ProfileConfig {
  profile: Profile;
  byEmail: Record<string, Profile>;
}

export function parseProfiles(raw: any): ProfileConfig {
  const profile = raw.profile === undefined ? "everyday" : raw.profile;
  if (!isProfile(profile)) throw new Error(`profile must be one of ${Object.keys(PROFILES).join(", ")} (got ${JSON.stringify(raw.profile)})`);
  const byEmail: Record<string, Profile> = {};
  for (const [email, p] of Object.entries(raw.profile_by_email ?? {})) {
    if (!isProfile(p)) throw new Error(`profile_by_email."${email}" must be one of ${Object.keys(PROFILES).join(", ")}`);
    byEmail[email.toLowerCase()] = p;
  }
  return { profile, byEmail };
}

/** Profile for a connection: its Access email's own, else the desk default. */
export function profileFor(cfg: ProfileConfig, email?: string | null): Profile {
  return (email && cfg.byEmail[email.toLowerCase()]) || cfg.profile;
}

export const featuresOf = (p: Profile) => new Set<Feature>(PROFILES[p]);

/** Throws when the profile doesn't include the feature an action needs. */
export function needFeature(features: Set<Feature>, f: Feature): void {
  if (!features.has(f)) throw new Error(`${f} is not part of your profile (developer profile needed)`);
}
