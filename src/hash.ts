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

/**
 * Titel und Namenszusätze, die kein Teil des Namens sind.
 *
 * Google verlangt das ausdrücklich („Don't include prefixes (ex: Mrs.)",
 * „Don't include suffixes (ex: Jr.)", support.google.com/google-ads/answer/7476159).
 * Meta verlangt es nicht, verbietet es aber auch nicht — wer „Dr." stehen
 * lässt, hasht bei Google garantiert daneben, wer ihn entfernt, riskiert bei
 * Meta nichts. Deshalb raus.
 *
 * Bewusst kurz gehalten: Jeder Eintrag hier ist ein Name, den wir jemandem
 * wegnehmen könnten. Was nicht sicher ein Titel ist, bleibt drin.
 */
const NAMENSZUSAETZE = new Set(["dr", "prof", "mr", "mrs", "ms", "miss", "jr", "sr"]);

/**
 * Vor-/Nachname so normalisieren, wie es ALLE Werbeplattformen mittragen.
 *
 * Belegt, nicht geraten — und an einer Stelle widersprechen sich die Anbieter,
 * deshalb steht hier, was warum passiert:
 *
 * 1. NFC. „ü" gibt es in Unicode zweimal (fertig komponiert und als u + ¨).
 *    Ein macOS-Dateidialog liefert das eine, ein Web-Formular das andere —
 *    unterschiedliche Bytes, unterschiedlicher Hash, kein Match. Keine
 *    Plattform schreibt NFC vor, weil keine mit dem Fall rechnet; genau
 *    deshalb müssen wir ihn abfangen.
 * 2. Trimmen und Mehrfach-Leerzeichen auf eines. Google: „Remove leading and
 *    trailing whitespaces." Innere Leerzeichen löscht KEINE Plattform bei
 *    Namen — Pinterest schreibt „without spaces or punctuation" ausdrücklich
 *    nur bei der Stadt (`ct`), bei `fn`/`ln` nicht. „maria anna" bleibt also
 *    zwei Wörter.
 * 3. Kleinschreiben mit toLowerCase, NICHT mit einer Case-Faltung. Eine
 *    Faltung macht aus „ß" ein „ss" und damit einen Hash, den keine Plattform
 *    berechnet.
 * 4. Umlaute und Akzente BLEIBEN, in UTF-8. Meta zeigt es am eigenen Beispiel
 *    („Valéry" → „valéry"), Google sagt „Accents are allowed". Eine
 *    Umschrift ä→ae oder ä→a wäre bei beiden falsch.
 * 5. Ziffern raus. Verlangt niemand, aber Meta empfiehlt „Roman alphabet a-z
 *    characters", und eine Ziffer im Vornamen ist praktisch immer ein
 *    Tippfehler oder ein ausgefülltes Spam-Formular.
 * 6. Titel und Namenszusätze raus (siehe oben).
 *
 * NICHT entfernt werden Satzzeichen — Bindestrich, Apostroph, Punkt. Das ist
 * die eine Stelle, an der sich die Anbieter widersprechen, und zwar Google
 * sogar mit sich selbst:
 *   Meta          „Lowercase only with no punctuation"      → entfernen
 *   GA4           „remove digits and symbol characters"     → entfernen
 *   Google Ads    „Accents are allowed", Beispiel „smith-jones" → behalten
 *   Pinterest     nennt „without spaces or punctuation" bei der Stadt (`ct`)
 *                 und lässt es bei `fn`/`ln` weg                → behalten
 * GA4 behauptet auf derselben Seite, es benutze „the same normalization and
 * hashing algorithm as the Google Ads API" — was mit Googles eigenem
 * „smith-jones" nicht zusammengeht. Wir folgen der Seite, die ein konkretes
 * Beispiel zeigt, und behalten die Satzzeichen. Dafür spricht auch, dass
 * Behalten die zurückhaltende Richtung ist: Im Feld steht dann, was der Kunde
 * geschrieben hat, und der Verlust trifft nur Namen MIT Satzzeichen — in
 * beide Richtungen gleich viele, aber nur in dieser Richtung nachvollziehbar.
 * Ein zweiter Hash nach Meta-Regel (wie `ph` neben `ph_e164`) wäre der
 * saubere Ausweg; er kostet ein weiteres Schemafeld und ist deshalb bewusst
 * vertagt, nicht vergessen.
 *
 * Quellen (Stand 2026-09-11):
 *   Meta   developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *   Google developers.google.com/google-ads/api/docs/conversions/enhance-conversions
 *          support.google.com/google-ads/answer/7476159
 *   GA4    developers.google.com/analytics/devguides/collection/ga4/uid-data
 *   Pinterest developers.pinterest.com/docs/api/v5/events-create
 *
 * Microsoft Ads, TikTok und LinkedIn tauchen hier nicht auf: Microsoft und
 * TikTok haben in ihrer Conversion-API überhaupt kein Namensfeld, LinkedIn
 * nimmt Namen ausdrücklich nur im Klartext („in plain text for probabilistic
 * user matching") — ein Hash wäre dort ein stiller Fehlschlag.
 *
 * Liefert den leeren String, wenn nach dem Aufräumen nichts übrig ist — der
 * Aufrufer lässt das Feld dann weg, statt den Hash des Leerstrings zu senden.
 * Der wäre bei jedem Besucher derselbe und damit ein Match-Signal, das alle
 * auf dieselbe Person zeigt.
 */
export function normalizeName(name: string): string {
  const gefaltet = name.normalize("NFC").toLowerCase().replace(/\d+/g, " ");
  return gefaltet
    .split(/\s+/)
    .filter((wort) => {
      const kern = wort.replace(/[.,]/g, "");
      return kern !== "" && !NAMENSZUSAETZE.has(kern);
    })
    .join(" ")
    .trim();
}

/**
 * SHA-256 über den normalisierten Vor- oder Nachnamen — das Format, in dem
 * `fn`/`ln` an den Collector gehen. Leerer Name, leeres Ergebnis: Dann hat der
 * Aufrufer nichts zu senden (siehe `normalizeName`).
 */
export async function hashName(name: string): Promise<string> {
  const normalisiert = normalizeName(name);
  return normalisiert === "" ? "" : sha256Hex(normalisiert);
}
