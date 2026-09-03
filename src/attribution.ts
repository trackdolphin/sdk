/**
 * First-Touch-Attribution im Browser.
 *
 * Warum first-touch: Kommt ein Besucher über eine Anzeige und später direkt
 * zurück, darf der bezahlte Klick nicht überschrieben werden. Neue UTM-/
 * Klick-ID-Signale in der URL überschreiben dagegen sehr wohl.
 *
 * Der Cookie-Name ist bewusst unauffällig (`_td_attr`) — Namen mit „track“
 * oder „utm“ stehen auf Ad-Blocker-Listen.
 */

const COOKIE = "_td_attr";
const MAX_AGE_DAYS = 90;

export interface Attribution {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbclid?: string;
  ttclid?: string;
  msclkid?: string;
  epik?: string;
  landing_path?: string;
  referrer?: string;
  captured_at?: string;
}

const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid", "epik"] as const;
const UTMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function writeCookie(name: string, value: string, days: number): void {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  // Kein `domain`-Attribut → gilt für den aktuellen Host (first-party).
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${
    location.protocol === "https:" ? "; Secure" : ""
  }`;
}

export function readAttribution(): Attribution {
  try {
    const raw = readCookie(COOKIE);
    return raw ? (JSON.parse(raw) as Attribution) : {};
  } catch {
    return {};
  }
}

/** Liest UTM-Parameter und Klick-IDs aus einem Query-String. */
function signalsFrom(search: string): Attribution {
  const params = new URLSearchParams(search);
  const fresh: Attribution = {};
  for (const k of [...UTMS, ...CLICK_IDS]) {
    const v = params.get(k);
    if (v) (fresh as Record<string, string>)[k] = v;
  }
  return fresh;
}

/**
 * Die URL, mit der die Seite tatsächlich geladen wurde — VOR clientseitigen
 * `replaceState`-Aufrufen. Frameworks wie Next.js (App Router) schreiben die
 * Adresszeile beim Hydrieren gern um: Locale-Redirect, Trailing-Slash,
 * ein `router.replace`, das die Query „aufräumt“. Wird das SDK erst danach
 * in einem Effekt initialisiert, ist `location.search` leer und die gclid
 * wäre verloren. Der Navigations-Eintrag der Performance-API trägt die
 * ursprüngliche URL noch.
 */
function navigationSearch(): string {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return "";
    const entry = performance.getEntriesByType("navigation")[0];
    if (!entry?.name) return "";
    return new URL(entry.name, location.href).search;
  } catch {
    return "";
  }
}

/**
 * Erfasst die Attribution beim Seitenaufruf. Überschreibt nur, wenn die
 * aktuelle URL neue Kampagnen-Signale trägt.
 */
export function captureAttribution(): Attribution {
  if (typeof document === "undefined") return {};
  let fresh = signalsFrom(location.search);
  // Nur als Rückfall: Trägt die aktuelle Adresse Signale, gelten diese.
  if (Object.keys(fresh).length === 0) fresh = signalsFrom(navigationSearch());

  const existing = readAttribution();
  const hasNewSignal = Object.keys(fresh).length > 0;
  if (!hasNewSignal && existing.captured_at) return existing;

  const next: Attribution = {
    ...(hasNewSignal ? fresh : existing),
    landing_path: location.pathname,
    referrer: document.referrer || existing.referrer || "",
    captured_at: new Date().toISOString(),
  };
  writeCookie(COOKIE, JSON.stringify(next), MAX_AGE_DAYS);
  return next;
}

/**
 * Baut `_fbc` aus einer gespeicherten `fbclid`, wenn der Meta-Pixel wegen
 * ausstehender Einwilligung nie geladen hat. Format ist von Meta vorgegeben.
 */
export function buildFbc(attr: Attribution): string | undefined {
  const fromCookie = readCookie("_fbc");
  if (fromCookie) return fromCookie;
  if (!attr.fbclid) return undefined;
  const ts = attr.captured_at ? Date.parse(attr.captured_at) : Date.now();
  return `fb.1.${ts}.${attr.fbclid}`;
}

/** GA4-Client-ID aus dem `_ga`-Cookie (Format GA1.1.<cid>). */
export function gaClientId(): string | undefined {
  const raw = readCookie("_ga");
  if (!raw) return undefined;
  const parts = raw.split(".");
  return parts.length >= 4 ? `${parts[2]}.${parts[3]}` : undefined;
}

export function fbp(): string | undefined {
  return readCookie("_fbp") ?? undefined;
}

const VISITOR_COOKIE = "_td_vid";

/**
 * Vorhandene Besucherkennung lesen, ohne eine anzulegen. Für Einbindungen
 * über die Proxy-Route (`@trackdolphin/sdk/proxy`): Dort setzt der eigene
 * Server das Cookie per `Set-Cookie` — mit voller Laufzeit auch in Safari.
 * Legte das SDK daneben per JavaScript ein zweites an, gäbe es zwei
 * Kennungen für denselben Besucher.
 */
export function readVisitorId(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return readCookie(VISITOR_COOKIE) ?? undefined;
}

/**
 * Stabile Besucherkennung (First-Party, 90 Tage). Rein zufällig — sie sagt
 * nichts über die Person aus, verknüpft aber deren Events untereinander.
 * Sobald eine gehashte E-Mail dazukommt, hängt die ganze bisherige Reise
 * rückwirkend an der Person.
 *
 * Schreibt das Cookie beim ersten Aufruf. Wer es an die Einwilligung binden
 * will, ruft die Funktion erst dann auf — siehe
 * `init({ visitorCookieRequiresConsent: true })`.
 */
export function visitorId(): string {
  if (typeof document === "undefined") return "";
  const existing = readCookie(VISITOR_COOKIE);
  if (existing) return existing;
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  writeCookie(VISITOR_COOKIE, id, MAX_AGE_DAYS);
  return id;
}
