/**
 * Fremde Werkzeuge beschriften — das gemeinsame Vokabular.
 *
 * Im Shop laufen oft schon Microsoft Clarity, PostHog oder Sentry. Alle drei
 * sehen, WAS passiert ist, aber keines weiß, WOHER der Besucher kam: Werbekanal,
 * Kampagne, Einwilligungsstand und Bestellwert entstehen serverseitig, in
 * Trackdolphin. Setzen wir dieses Wissen dort als Merkmal, wird die Aufzeichnung
 * beziehungsweise der Fehler nach Dingen filterbar, die das fremde Werkzeug aus
 * eigener Kraft nie kennen könnte.
 *
 * Vier Entscheidungen prägen diese Datei und alle Adapter daneben:
 *
 * 1. WIR LADEN NICHTS. Kein fremdes Skript wird von uns ausgeliefert. Wir
 *    sprechen ein globales Objekt nur an, wenn der Shop es selbst eingebunden
 *    hat. Lieferten wir es aus, erbten wir dessen Regressionen — und die kämen
 *    beim Kunden als Trackdolphin-Fehler an. Erkennen statt injizieren.
 *
 * 2. WIR HOLEN NICHTS ZURÜCK. Kein Schlüssel, kein OAuth, keine Ratenlimits,
 *    keine fremden Ausfälle in unserem Betrieb. Nur schieben. Einzige Ausnahme
 *    ist PostHogs Sitzungskennung, und die wird clientseitig ausgelesen, nicht
 *    über eine API geholt.
 *
 * 3. NIEMALS PERSONENBEZUG. Keine Besucherkennung, keine Bestellnummer, keine
 *    E-Mail, kein Hash davon. Das ist nicht Vereinbarung, sondern Bauweise:
 *    `buildTags()` nimmt nur Attribution, Einwilligungsstand und eine Zahl
 *    entgegen — es gibt keinen Parameter, durch den eine Kennung hineinkäme.
 *
 * 4. NICHTS DARF WERFEN. Ein fehlerhaftes Fremdskript darf weder das Tracking
 *    noch die Seite kosten. Jeder Adapter kapselt seine Aufrufe.
 *
 * Die Schreibsemantik gehört NICHT hierher, sondern in den jeweiligen Adapter:
 * Clarity hängt bei gleichem Schlüssel an, PostHog und Sentry überschreiben.
 * Eine gemeinsame Implementierung wäre bei genau einem der drei falsch.
 */

import type { Attribution } from "./attribution.ts";

/** Präfix aller von uns gesetzten Merkmale — erkennbar und kollisionsfrei. */
export const PREFIX = "td_";

/**
 * Gemeinsame Obergrenze für Werte, aus der jeweils strengsten der drei:
 *
 * - Sentry: 200 Zeichen je Schlüssel und Wert, und das SDK kürzt NICHT selbst
 *   (`maxValueLength` gilt dort nur für `request.url` und `exception.value`) —
 *   gekürzt würde erst serverseitig und für uns unsichtbar.
 * - Clarity: 254 Zeichen, und zu lange Werte werden still VERWORFEN statt
 *   gekürzt — ein zu langer Kampagnenname ergäbe also gar kein Merkmal.
 * - PostHog: keine dokumentierte Grenze.
 *
 * 120 liegt sicher unter allen dreien und hält die Filterlisten lesbar.
 */
export const MAX_VALUE_LENGTH = 120;

/**
 * Clarity ignoriert ab 128 Merkmalen je Seite alles Weitere; Sentry und PostHog
 * nennen keine Anzahlgrenze. Wir setzen vier bis fünf — die Zahl steht hier,
 * damit sie beim Erweitern jemand sieht.
 */
export const MAX_TAGS_PER_PAGE = 128;

/**
 * Erlaubter Zeichensatz für Schlüssel, aus Sentrys Regel übernommen
 * (`a-zA-Z0-9._:-`, keine Leerzeichen). Für Clarity und PostHog unschädlich.
 * PostHog reserviert zusätzlich das führende `$` — unser `td_` trifft das nicht.
 *
 * Wichtig: Schlüsselnamen bleiben STATISCH, Varianz steckt nur im Wert. PostHog
 * drosselt die Anlage neuer Property-Definitionen; wer Schlüssel dynamisch
 * bildet, dessen neue Schlüssel erscheinen irgendwann gar nicht mehr im Filter.
 */
const KEY_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/**
 * Auf ein merkmalstaugliches Format bringen: Kleinbuchstaben, nur Wortzeichen,
 * Punkt und Bindestrich, gekürzt. Das schützt zugleich davor, dass ein kurioser
 * Kampagnenname (Leerzeichen, Emoji, Zeilenumbruch) den Filter unbrauchbar
 * macht — Sentry verbietet `\n` im Wert ausdrücklich.
 */
export function sanitizeTagValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_VALUE_LENGTH);
}

/** Bezahlte Kanäle, erkannt an der Klick-ID — die ist eindeutiger als jedes UTM. */
const CLICK_ID_CHANNEL: Array<[keyof Attribution, string]> = [
  ["gclid", "google_paid"],
  ["gbraid", "google_paid"],
  ["wbraid", "google_paid"],
  ["fbclid", "meta_paid"],
  ["ttclid", "tiktok_paid"],
  ["msclkid", "microsoft_paid"],
  ["epik", "pinterest_paid"],
  ["oppref", "openai_paid"],
];

/** Hosts, deren Verweis ohne Klick-ID organische Suche bedeutet. */
const SEARCH_HOSTS = /(^|\.)(google\.[a-z.]+|bing\.com|duckduckgo\.com|ecosia\.org|search\.brave\.com|yahoo\.[a-z.]+)$/i;

/** Bezahlt-Marker in `utm_medium`, wenn keine Klick-ID vorliegt. */
const PAID_MEDIUM = /^(cpc|ppc|paid|paidsocial|paid_social|display|cpm|retargeting)$/i;

/**
 * Kanal aus der First-Touch-Attribution ableiten.
 *
 * Reihenfolge nach Verlässlichkeit: Klick-ID schlägt UTM, UTM schlägt
 * Verweisadresse. Eine gclid ist ein Beleg, ein `utm_source=google` ist eine
 * Behauptung, die jeder Newsletter tragen kann.
 */
export function deriveChannel(attr: Attribution): string {
  for (const [key, channel] of CLICK_ID_CHANNEL) {
    if (attr[key]) return channel;
  }

  const medium = attr.utm_medium ?? "";
  const source = attr.utm_source ? sanitizeTagValue(attr.utm_source) : "";

  if (medium && PAID_MEDIUM.test(medium)) return source ? `${source}_paid` : "paid";
  if (medium) return source ? `${source}_${sanitizeTagValue(medium)}` : sanitizeTagValue(medium);
  if (source) return source;

  const referrer = attr.referrer ?? "";
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname;
    if (typeof location !== "undefined" && host === location.hostname) return "direct";
    if (SEARCH_HOSTS.test(host)) return "organic_search";
    return `referral_${sanitizeTagValue(host.replace(/^www\./, ""))}`;
  } catch {
    return "referral";
  }
}

/**
 * Bestellwert in ein Band einsortieren.
 *
 * Bewusst der Wert als Band und nicht als Zahl: Ein exakter Betrag ist zusammen
 * mit einem Zeitstempel ein Wiedererkennungsmerkmal, ein Band ist es nicht.
 * Die Grenzen sind für Shops gewählt, nicht für Enterprise-Verträge.
 */
export function valueBand(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown";
  if (value < 25) return "0_25";
  if (value < 50) return "25_50";
  if (value < 100) return "50_100";
  if (value < 250) return "100_250";
  if (value < 500) return "250_500";
  if (value < 1000) return "500_1000";
  return "1000_plus";
}

/**
 * Der Einwilligungszustand, auf drei filterbare Fälle eingedampft.
 *
 * `null`, solange keine Entscheidung vorliegt — dann bleibt das Merkmal weg.
 * Ein vorläufiges „unset“ wäre bei Clarity fatal, weil ein späteres Setzen es
 * nicht ersetzen, sondern ergänzen würde.
 */
export function consentTag(state: object | null): string | null {
  if (!state) return null;
  // Nur Signalwerte zählen: `source` und `cmp` sind Herkunft, keine
  // Entscheidung, und machten aus jedem „granted" sonst ein „partial".
  const values = Object.values(state as Record<string, unknown>)
    .map((v) => (v === true ? "granted" : v === false ? "denied" : v))
    .filter((v) => v === "granted" || v === "denied");
  if (values.length === 0) return null;
  const granted = values.filter((v) => v === "granted").length;
  if (granted === 0) return "denied";
  if (granted === values.length) return "granted";
  return "partial";
}

export interface EnrichmentInput {
  attribution?: Attribution;
  /** Consent-Mode-Zustand, wie ihn das SDK führt. */
  consent?: object | null;
  /** Nur beim Kauf-Event gesetzt. */
  purchaseValue?: number;
  /**
   * Serverseitiger Befund, falls er noch während der Sitzung vorliegt: kam die
   * Conversion an den Zielen an? Ohne Antwort bleibt das Merkmal weg — ein
   * geratenes „ja“ wäre schlimmer als gar keines.
   */
  attributed?: boolean;
}

/**
 * Die Merkmale für diese Sitzung berechnen. Rein — ohne Browserzugriff, damit
 * sie sich prüfen lässt, und für alle drei Anbieter identisch.
 */
export function buildTags(input: EnrichmentInput): Record<string, string> {
  const tags: Record<string, string> = {};
  const attr = input.attribution ?? {};

  tags[`${PREFIX}channel`] = deriveChannel(attr);
  if (attr.utm_campaign) tags[`${PREFIX}campaign`] = sanitizeTagValue(attr.utm_campaign);
  const consent = consentTag(input.consent ?? null);
  if (consent) tags[`${PREFIX}consent`] = consent;
  if (typeof input.purchaseValue === "number") {
    tags[`${PREFIX}value_band`] = valueBand(input.purchaseValue);
  }
  if (typeof input.attributed === "boolean") {
    tags[`${PREFIX}attributed`] = input.attributed ? "yes" : "no";
  }

  // Letzte Sicherung: Kein Schlüssel verlässt uns mit einem Zeichen, das
  // Sentry ablehnen würde, und keiner ohne unser Präfix.
  for (const key of Object.keys(tags)) {
    if (!key.startsWith(PREFIX) || !KEY_PATTERN.test(key)) delete tags[key];
  }
  return tags;
}

/**
 * Ein Adapter für ein fremdes Werkzeug.
 *
 * `apply` bekommt die fertigen Merkmale und entscheidet selbst, wie es sie
 * schreibt — das ist die Stelle, an der sich die drei unterscheiden. Der
 * Rückgabewert sagt, ob das Werkzeug gefunden wurde.
 */
export interface EnrichmentAdapter {
  readonly name: string;
  apply(tags: Record<string, string>): boolean;
  reset(): void;
}
