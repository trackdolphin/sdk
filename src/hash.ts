/**
 * Normalisierung und Hashing der Match-Signale.
 *
 * Der Collector nimmt `em`/`ph` NUR als SHA-256-Hex an — Klartext-PII wird
 * abgewiesen. Diese Funktionen sind der vorgesehene Weg dorthin; sie
 * normalisieren vorher genau so, wie es die Plattformen erwarten
 * (Meta/Google hashen selbst identisch, sonst matcht nichts).
 */

/** Web Crypto — im Browser und in Node ≥18 identisch verfügbar. */
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** E-Mail: trimmen, kleinschreiben. (Gmail-Punkte NICHT entfernen — die
 *  Plattformen tun das auch nicht, sonst weichen die Hashes ab.) */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Telefonnummer nach E.164 ohne führendes „+“.
 * Meta erwartet reine Ziffern; `defaultCountry` greift, wenn die Nummer
 * national notiert ist (führende 0 wird dabei korrekt ersetzt).
 */
export function normalizePhone(phone: string, defaultCountry = "49"): string {
  let p = phone.trim().replace(/[^\d+]/g, "");
  if (p.startsWith("+")) return p.slice(1).replace(/\D/g, "");
  if (p.startsWith("00")) return p.slice(2);
  if (p.startsWith("0")) return defaultCountry + p.slice(1);
  // Bereits mit Ländervorwahl notiert?
  if (p.startsWith(defaultCountry)) return p;
  return defaultCountry + p;
}

export async function hashEmail(email: string): Promise<string> {
  return sha256Hex(normalizeEmail(email));
}

/**
 * Telefon-Hash für Meta: Ziffern mit Ländervorwahl, OHNE Pluszeichen.
 * Google Ads und GA4 verlangen dieselbe Nummer MIT Plus — siehe hashPhoneE164.
 * Ein Hash kann nicht beide bedienen; wer nur einen schickt, verliert bei der
 * anderen Plattform jede Zuordnung über die Telefonnummer.
 */
export async function hashPhone(phone: string, defaultCountry = "49"): Promise<string> {
  return sha256Hex(normalizePhone(phone, defaultCountry));
}

/** Bereits gehashte Werte durchreichen, Klartext hashen. */
export async function ensureHashed(value: string, kind: "email" | "phone"): Promise<string> {
  if (/^[a-f0-9]{64}$/i.test(value.trim())) return value.trim().toLowerCase();
  return kind === "email" ? hashEmail(value) : hashPhone(value);
}

/**
 * Telefon-Hash für Google Ads und GA4: E.164 MIT führendem Pluszeichen.
 * Dieselbe Normalisierung wie hashPhone, nur mit `+` davor — die beiden
 * Plattform-Vorgaben unterscheiden sich genau in diesem einen Zeichen.
 */
export async function hashPhoneE164(phone: string, defaultCountry = "49"): Promise<string> {
  return sha256Hex(`+${normalizePhone(phone, defaultCountry)}`);
}
