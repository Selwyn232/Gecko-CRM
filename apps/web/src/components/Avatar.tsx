/** Rondje met initialen; de kleur hangt vast aan de naam, zodat iemand overal dezelfde kleur heeft. */
const COLORS = ["#2a78d6", "#1f8a5c", "#8a5cd1", "#c25e00", "#0f8a8a", "#c2410c", "#4f6bd8", "#a3367a"];

export function initials(name: string) {
  // Zonder toevoegingen tussen haakjes ("(test)", "(voorbeeld)") en aanhef.
  const clean = name.replace(/\([^)]*\)/g, " ").replace(/^\s*(fam\.|familie|dhr\.|mevr\.|de heer|mevrouw)\s+/i, "");
  const words = clean.split(/[\s-]+/).filter((w) => /^[A-Za-zÀ-ÿ0-9]/.test(w));
  // Tussenvoegsels (van, de, der …) overslaan bij de tweede letter.
  const main = words.filter((w, i) => i === 0 || !/^(van|de|der|den|het|ter|ten|te|op|in|bv|b\.v\.)$/i.test(w));
  const first = main[0]?.[0] ?? "?";
  const last = main.length > 1 ? main[main.length - 1]![0] : (main[0]?.[1] ?? "");
  return (first + last).toUpperCase();
}

export function avatarColor(name: string) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

export function Avatar({ name, size = 26, photo }: { name: string; size?: number; /** URL van de profielfoto (selfie) */ photo?: string | null }) {
  if (photo) return <img className="avatar" src={photo} alt="" width={size} height={size} style={{ width: size, height: size, objectFit: "cover" }} />;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: avatarColor(name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** Naam met avatar ervoor (in tabellen en details). */
export function WithAvatar({ name, size, strong }: { name: string; size?: number; strong?: boolean }) {
  if (!/[A-Za-zÀ-ÿ0-9]/.test(name)) return strong ? <strong>{name}</strong> : <>{name}</>;
  return (
    <span className="with-avatar">
      <Avatar name={name} size={size} />
      {strong ? <strong>{name}</strong> : <span>{name}</span>}
    </span>
  );
}

/** URL van de eigen of andermans profielfoto (met versie, zodat een nieuwe foto direct zichtbaar is). */
export const photoUrl = (userId: string, version?: string | null) => (version ? `/api/users/${userId}/photo?v=${version}` : null);
