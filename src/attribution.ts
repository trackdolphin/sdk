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
  oppref?: string;
  landing_path?: string;
  referrer?: string;
  captured_at?: string;
}

/**
 * Die Klick-Kennungen, die wir aus der Landing-URL herausschreiben.
 *
 * `oppref` ist die von OpenAI/ChatGPT Ads. Sie steht hier, obwohl das Ziel
 * noch nicht angebunden ist: Eine Kennung, die beim Seitenaufruf nicht
 * mitgeschrieben wird, ist später nicht nachholbar — der Klick ist dann
 * vorbei. Das Cookie dazu heisst `__oppref` mit ZWEI Unterstrichen, anders
 * als bei allen bisherigen; ausgelesen wird es am Edge (siehe
 * `apps/collector/src/enrich.ts`), hier zählt nur der Query-Parameter.
 *
 * Nicht zu verwechseln mit `obref` aus dem Cookie `__obref` — das ist bei
 * OpenAI ein Nutzerdatenfeld, kein Event-Feld, und gehört nicht hierher.
 */
const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid", "epik", "oppref"] as const;
const UTMS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;

/**
 * Cookie lesen. `document.cookie` ist nicht überall zugänglich: In einem
 * `<iframe sandbox>` ohne `allow-same-origin` wirft schon der Zugriff einen
 * SecurityError, und ein kaputtes `%`-Zeichen im Wert lässt
 * `decodeURIComponent` werfen. Beides darf höchstens Attribution kosten,
 * niemals die Seite, in der das SDK steckt.
 */
function readCookie(name: string): string | null {
  try {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]!) : null;
  } catch {
    return null;
  }
}

/** Cookie schreiben — schlägt es fehl (Sandbox, blockierte Cookies, volle
 *  Cookie-Ablage), gilt der Wert eben nur für diese Seite. */
function writeCookie(name: string, value: string, days: number): void {
  try {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    // Kein `domain`-Attribut → gilt für den aktuellen Host (first-party).
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax${
      location.protocol === "https:" ? "; Secure" : ""
    }`;
  } catch {
    /* ohne Cookie-Zugriff lebt die Kennung nur bis zum Seitenwechsel */
  }
}

// ---------------------------------------------------------------------------
// Kontaktliste
// ---------------------------------------------------------------------------

/**
 * Ein Kontakt: ein Besuch mit Herkunftssignal. Dieselbe Form wie
 * `Touchpoint` in `@trackdolphin/attribution` — das SDK hat keine
 * Abhängigkeiten, deshalb steht sie hier noch einmal; `attribution.test.ts`
 * hält beide zusammen. Nur die ART der Klick-Kennung, nicht ihr Wert: Der
 * steht als Zustell-Signal ohnehin am Ereignis, und zehn Kontakte mit je
 * einer 100 Zeichen langen gclid passten in kein Cookie.
 */
export interface Touchpoint {
  at: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  click?: (typeof CLICK_IDS)[number];
  /** Host des Referrers ohne www., klein. */
  referrer?: string;
  landing?: string;
}

/**
 * Eigener Cookie neben `_td_attr`: Der bleibt der erste Kontakt in seiner
 * alten Form (andere lesen ihn), dieser hier trägt die Liste. Zwei Cookies
 * à höchstens ~2 KB statt einem an der 4-KB-Grenze.
 */
const TOUCH_COOKIE = "_td_touch";
export const MAX_TOUCHES = 10;
const TOUCH_VALUE_MAX = 100;
const TOUCH_LANDING_MAX = 200;
/** Gleiche Signale innerhalb dieser Spanne sind ein Kontakt (Neuladen, Zurück). */
const TOUCH_DEDUPE_MS = 30 * 60 * 1000;

export function readTouches(): Touchpoint[] {
  try {
    const raw = readCookie(TOUCH_COOKIE);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as Touchpoint[]).slice(0, MAX_TOUCHES) : [];
  } catch {
    return [];
  }
}

function kurz(v: string | null, max: number): string | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().slice(0, max);
  return s === "" ? undefined : s;
}

/** Host ohne `www.`, klein — oder undefined, wenn es keiner ist. */
function referrerHost(referrer: string): string | undefined {
  try {
    const host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, "");
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * Dieselbe Seite? Registrierbare Domain statt Host — `join.shop.de` und
 * `www.shop.de` sind eine Seite. Spiegel von `gleicheSeite` im
 * Attribution-Paket; `attribution.test.ts` hält beide zusammen.
 */
function sameSite(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const core = (host: string): string => {
    const parts = host.toLowerCase().split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    const second = parts[parts.length - 2]!;
    const tld = parts[parts.length - 1]!;
    const n = tld.length === 2 && /^(co|com|org|net|gov|ac|edu|or|ne|go)$/.test(second) ? 3 : 2;
    return parts.slice(-n).join(".");
  };
  return core(a) === core(b);
}

/** Kontakt aus einem Seitenaufruf — Verweise von der eigenen Seite zählen nicht. */
export function touchFrom(search: string, referrer: string, path: string, ownHost: string, at: string): Touchpoint {
  const params = new URLSearchParams(search);
  const t: Touchpoint = { at };
  const source = kurz(params.get("utm_source"), TOUCH_VALUE_MAX);
  const medium = kurz(params.get("utm_medium"), TOUCH_VALUE_MAX);
  const campaign = kurz(params.get("utm_campaign") ?? params.get("utm_id"), TOUCH_VALUE_MAX);
  const content = kurz(params.get("utm_content"), TOUCH_VALUE_MAX);
  const term = kurz(params.get("utm_term"), TOUCH_VALUE_MAX);
  if (source) t.source = source;
  if (medium) t.medium = medium;
  if (campaign) t.campaign = campaign;
  if (content) t.content = content;
  if (term) t.term = term;
  for (const kind of CLICK_IDS) {
    if (params.get(kind)) {
      t.click = kind;
      break;
    }
  }
  const host = referrer ? referrerHost(referrer) : undefined;
  if (host && !sameSite(host, ownHost)) t.referrer = host;
  if (path) t.landing = path.slice(0, TOUCH_LANDING_MAX);
  return t;
}

function hasSignal(t: Touchpoint): boolean {
  return Boolean(t.source || t.medium || t.campaign || t.click || t.referrer);
}

function sameSignals(a: Touchpoint, b: Touchpoint): boolean {
  return (
    (a.source ?? "") === (b.source ?? "") &&
    (a.medium ?? "") === (b.medium ?? "") &&
    (a.campaign ?? "") === (b.campaign ?? "") &&
    (a.click ?? "") === (b.click ?? "") &&
    (a.referrer ?? "") === (b.referrer ?? "")
  );
}

/**
 * Einen Besuch einordnen — dieselben drei Regeln wie
 * `kontakteZusammenfuehren` im Attribution-Paket: ohne Signal kein Kontakt
 * (ein Direktbesuch überschreibt keine Kampagne), gleiche Signale kurz
 * hintereinander sind einer, und wird die Liste zu lang, fällt der ZWEITE
 * Kontakt heraus — der erste ist nicht nachholbar.
 */
export function mergeTouches(existing: Touchpoint[], next: Touchpoint): Touchpoint[] {
  if (!hasSignal(next)) return existing;
  const last = existing[existing.length - 1];
  if (last && sameSignals(last, next)) {
    const gap = Date.parse(next.at) - Date.parse(last.at);
    if (Number.isFinite(gap) && gap >= 0 && gap < TOUCH_DEDUPE_MS) return existing;
  }
  const out = [...existing, next];
  while (out.length > MAX_TOUCHES) out.splice(1, 1);
  return out;
}

/**
 * Den aktuellen Seitenaufruf als Kontakt festhalten. Läuft beim `init()`,
 * neben `captureAttribution()`: Das eine hält den ersten Kontakt in der
 * alten Form, das andere die Liste. Schreibt nur, wenn sich etwas ändert.
 */
export function captureTouch(): Touchpoint[] {
  if (typeof document === "undefined") return [];
  let search = location.search;
  if (!new URLSearchParams(search).toString()) search = navigationSearch();
  const existing = readTouches();
  const next = touchFrom(search, document.referrer || "", location.pathname, location.hostname, new Date().toISOString());
  const merged = mergeTouches(existing, next);
  if (merged !== existing) writeCookie(TOUCH_COOKIE, JSON.stringify(merged), MAX_AGE_DAYS);
  return merged;
}

// ---------------------------------------------------------------------------
// Sitzung
// ---------------------------------------------------------------------------

const SESSION_KEY = "_td_sid";
/** Nach dieser Stille beginnt eine neue Sitzung — GA4s Vorgabe. */
const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Sitzungskennung: zufällig, im sessionStorage (stirbt mit dem Tab), nach
 * 30 Minuten ohne Ereignis neu. Sie verbindet die Schritte eines Besuchs —
 * `page_view`, `form_started`, `lead` — und macht „Besuche je Kanal"
 * zählbar. Bisher schickte das SDK keine; der Trichter hatte deshalb nur
 * die Person als Klammer, und die hält über Wochen.
 */
export function sessionId(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const now = Date.now();
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const [id, t] = raw.split(".");
      if (id && now - Number(t) < SESSION_IDLE_MS) {
        sessionStorage.setItem(SESSION_KEY, `${id}.${now}`);
        return id;
      }
    }
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "").slice(0, 24)
        : Math.random().toString(36).slice(2) + now.toString(36);
    sessionStorage.setItem(SESSION_KEY, `${id}.${now}`);
    return id;
  } catch {
    return undefined;
  }
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
 * Die Kampagnen-Signale DIESES Seitenaufrufs, ohne das Endgerät anzufassen.
 *
 * Für den Modus „sammeln" (docs/drei-modi.md): Die `gclid` steht in der
 * Adresse, nicht auf dem Gerät — sie darf mitgehen, auch wenn kein Cookie
 * gelesen oder geschrieben werden darf. Was aus einem früheren Besuch stammt,
 * fehlt dann; das ist der Preis und nicht zu umgehen.
 */
export function urlSignals(): Attribution {
  if (typeof location === "undefined") return {};
  const fresh = signalsFrom(location.search);
  return Object.keys(fresh).length > 0 ? fresh : signalsFrom(navigationSearch());
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
 *
 * `geraet: false` (Modus „sammeln") heisst: kein Blick ins Cookie. Dann zählt
 * allein die `fbclid` dieser Adresse — die steht in der URL, nicht auf dem
 * Gerät.
 */
export function buildFbc(attr: Attribution, geraet = true): string | undefined {
  const fromCookie = geraet ? readCookie("_fbc") : "";
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
