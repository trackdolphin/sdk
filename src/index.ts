/**
 * Trackdolphin Browser-SDK.
 *
 *   import { init, track } from "@trackdolphin/sdk";
 *   init({ endpoint: "/td" });   // Proxy-Route im eigenen Framework, siehe @trackdolphin/sdk/proxy
 *   track({ type: "view_item", items: [{ id: "SKU-1", price: 29.9 }] });
 *
 * Erledigt automatisch: First-Touch-Attribution (90 Tage), Klick-IDs,
 * GA-Client-ID, `_fbc`-Rekonstruktion, Event-IDs, Hashing von E-Mail/Telefon,
 * Consent Mode v2 und eine Warteschlange für Events vor der
 * Consent-Entscheidung.
 */
import { buildFbc, captureAttribution, fbp, gaClientId, readAttribution, readVisitorId, visitorId } from "./attribution.ts";
import { ensureHashed, hashEmail, hashPhone, hashPhoneE164 } from "./hash.ts";
import { newEventId, type ConsentState, type TrackEvent, type Traits } from "./types.ts";

export * from "./types.ts";
export * from "./hash.ts";
export { captureAttribution, readAttribution, readVisitorId, visitorId } from "./attribution.ts";
export {
  backfill,
  backfillEventId,
  type BackfillItem,
  type BackfillOptions,
  type BackfillOrder,
  type BackfillResult,
  type BackfillTransport,
  type BackfillTransportResult,
} from "./backfill.ts";

export interface InitOptions {
  /**
   * Wohin die Events gehen. Empfohlen: die eigene Proxy-Route, relativ
   * (`"/td"`, siehe `@trackdolphin/sdk/proxy`) — dann sieht der Browser nur
   * die Shop-Domain. Alternativ die vollständige Collector-URL aus der
   * Einrichtungs-Seite.
   */
  endpoint: string;
  /**
   * Direkte Collector-URL als Rückfall, wenn `endpoint` eine Proxy-Route ist.
   * Antwortet die Route nicht (Transportfehler, 5xx, fehlende Route), merkt
   * sich die Sitzung das und sendet den Rest direkt — lieber ein Event ohne
   * Tarnung als gar keins.
   */
  fallbackEndpoint?: string;
  /**
   * Wer die Besucherkennung `_td_vid` vergibt. `"server"`: die Proxy-Route
   * setzt sie per Set-Cookie (volle Laufzeit auch in Safari); das SDK liest
   * ein vorhandenes Cookie nur. `"client"`: das SDK schreibt es selbst per
   * JavaScript. Standard: `"server"` bei relativem oder gleichherkünftigem
   * `endpoint`, sonst `"client"` — zwei Schreiber ergäben zwei Kennungen.
   */
  visitorId?: "server" | "client";
  /** Nur nötig, wenn NICHT an den shop-eigenen Host gesendet wird. */
  shopId?: string;
  /**
   * Ohne Einwilligung nichts senden? Events werden dann gepuffert und beim
   * Freischalten nachgesendet. Server-seitige Events sind davon unberührt.
   */
  requireConsent?: boolean;
  /**
   * Das Besucher-Cookie (`_td_vid`) erst schreiben und `visitor_id` erst
   * mitschicken, wenn `ad_storage` oder `analytics_storage` gewährt wurde.
   * Standard false: Das Cookie ist rein zufällig und first-party; wer es
   * trotzdem an die Einwilligung binden will (oder muss), schaltet hier um.
   */
  visitorCookieRequiresConsent?: boolean;
  /** Maximale Größe der Warteschlange (Schutz vor Endlos-Puffern). */
  queueLimit?: number;
  /**
   * Umgebung dieser Einbindung (z. B. „staging“ auf der Testinstanz). Wird
   * jedem Event mitgegeben; ohne Angabe füllt der Collector „production“.
   */
  environment?: string;
  debug?: boolean;
}

/** Eingabe für `identify()` — Klartext, wird lokal gehasht. */
export interface IdentifyInput {
  email?: string;
  phone?: string;
  /** Stabile Kundenkennung aus dem eigenen System (Kundennummer, User-ID). */
  externalId?: string;
  traits?: Traits;
}

/**
 * Was von `identify()` im Browser bleibt: nur Hashes und die Kennung.
 * Klartext landet nie im Speicher — ein XSS auf der Seite fände nichts
 * Lesbares, und der Collector nähme ihn ohnehin nicht an.
 */
interface StoredIdentity {
  em?: string;
  ph?: string;
  ph_e164?: string;
  external_id?: string;
}

const IDENTITY_KEY = "_td_id";
/** Sitzungsweite Entscheidung „Proxy trägt“ / „Rückfall“ — wie im Plugin-Snippet. */
const TRANSPORT_KEY = "_td_tx";

type Transport = "" | "same-origin" | "fallback";

let options: InitOptions | null = null;
/** Aufgelöste Zieladresse (relativ → absolut) — sendBeacon und fetch bekommen nie eine rohe relative Angabe. */
let endpointUrl = "";
let visitorMode: "server" | "client" = "client";
let transport: Transport = "";
let consentGranted = true;
/** Der zuletzt gesetzte Consent-Mode-v2-Zustand; null = nie gesetzt. */
let consentState: ConsentState | null = null;
const queue: TrackEvent[] = [];

function log(...args: unknown[]): void {
  if (options?.debug) console.info("[trackdolphin]", ...args);
}

/** Absolute Adresse; relative Angaben gelten gegenüber der aktuellen Seite. */
function resolveEndpoint(endpoint: string): string {
  try {
    return typeof location === "undefined" ? endpoint : new URL(endpoint, location.href).toString();
  } catch {
    return endpoint;
  }
}

/** Geht der Request an die Herkunft der Seite — also an den eigenen Server? */
function sameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === new URL(location.href).origin;
  } catch {
    return false;
  }
}

function readTransport(): Transport {
  try {
    const v = sessionStorage.getItem(TRANSPORT_KEY);
    return v === "same-origin" || v === "fallback" ? v : "";
  } catch {
    return "";
  }
}

function rememberTransport(mode: Transport): void {
  transport = mode;
  try {
    sessionStorage.setItem(TRANSPORT_KEY, mode);
  } catch {
    /* ohne Speicher gilt die Entscheidung nur für diese Seite */
  }
}

export function init(opts: InitOptions): void {
  options = { queueLimit: 50, requireConsent: false, visitorCookieRequiresConsent: false, ...opts };
  consentGranted = !options.requireConsent;
  endpointUrl = resolveEndpoint(options.endpoint);
  // Ohne Rückfall gibt es nichts zu entscheiden — dann bleibt alles beim Ziel.
  transport = options.fallbackEndpoint ? readTransport() : "";
  visitorMode = options.visitorId ?? (sameOrigin(endpointUrl) ? "server" : "client");
  captureAttribution();
  log("initialisiert", endpointUrl, "· Besucherkennung:", visitorMode);
}

const ALL_GRANTED: ConsentState = {
  ad_storage: "granted",
  analytics_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
};
const ALL_DENIED: ConsentState = {
  ad_storage: "denied",
  analytics_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
};

/** Speicher-Einwilligung: Sobald eines der beiden Storage-Signale gewährt ist. */
function storageGranted(state: ConsentState): boolean {
  return state.ad_storage === "granted" || state.analytics_storage === "granted";
}

/**
 * Einwilligung setzen — als Ja/Nein oder granular nach Consent Mode v2.
 *
 * `true` entspricht allen vier Signalen „granted“, `false` allen „denied“.
 * Gesendet wird, sobald `ad_storage` ODER `analytics_storage` gewährt ist;
 * dann wird die Warteschlange abgearbeitet — ohne das gehen alle Events
 * verloren, die vor der Banner-Entscheidung ausgelöst wurden (typisch: der
 * erste Seitenaufruf). Der Zustand wandert als Feld `consent` in jedes
 * Event, damit die Plattformen selbst entscheiden, was sie verwenden dürfen.
 */
export function setConsent(granted: boolean | ConsentState): void {
  consentState = typeof granted === "boolean" ? (granted ? ALL_GRANTED : ALL_DENIED) : { ...granted };
  consentGranted = storageGranted(consentState);
  log("consent", consentState, "· Warteschlange:", queue.length);
  if (!consentGranted) return;
  const pending = queue.splice(0, queue.length);
  for (const ev of pending) void send(ev);
}

/** Darf das Besucher-Cookie heute geschrieben und mitgeschickt werden? */
function visitorCookieAllowed(): boolean {
  if (!options?.visitorCookieRequiresConsent) return true;
  return consentState !== null && storageGranted(consentState);
}

/**
 * Die Besucherkennung für ein Event. Im Server-Modus wird nur gelesen — die
 * Proxy-Route vergibt sie und schreibt sie selbst in den Payload. Einzige
 * Ausnahme: Läuft die Sitzung im Rückfall direkt zum Collector, setzt kein
 * Server ein Cookie; dann ist eine kurzlebige JS-Kennung besser als keine,
 * und der Proxy übernimmt sie später, statt eine zweite zu vergeben.
 */
function currentVisitorId(): string | undefined {
  if (!visitorCookieAllowed()) return undefined;
  if (visitorMode === "server" && transport !== "fallback") return readVisitorId();
  return visitorId() || undefined;
}

function readIdentity(): StoredIdentity {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? (JSON.parse(raw) as StoredIdentity) : {};
  } catch {
    return {};
  }
}

function writeIdentity(id: StoredIdentity): void {
  try {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(id));
  } catch {
    // Safari-Privatmodus, volle Quota, blockierter Speicher: Dann gilt die
    // Identität nur für diese Seite — besser als ein Fehler beim Login.
  }
}

/**
 * Person erkennen (Login, Newsletter, Checkout-Formular). E-Mail und Telefon
 * werden hier gehasht; gespeichert werden nur die Hashes und `externalId`.
 * Ab jetzt trägt jedes Event `em`, `ph`, `ph_e164` und `external_id`, sofern
 * es sie nicht selbst mitbringt. Einmalig geht ein Event `identify` mit den
 * `traits` raus — daraus bildet die App Kohorten.
 */
export async function identify(input: IdentifyInput): Promise<void> {
  const previous = readIdentity();
  const next: StoredIdentity = { ...previous };
  if (input.email) next.em = await hashEmail(input.email);
  if (input.phone) {
    // Zwei Hashes: Meta verlangt die Nummer ohne, Google mit Pluszeichen.
    next.ph = await hashPhone(input.phone);
    next.ph_e164 = await hashPhoneE164(input.phone);
  }
  if (input.externalId) next.external_id = input.externalId;
  writeIdentity(next);
  log("identify", Object.keys(next));
  track({ type: "identify", traits: input.traits });
}

/** Identität vergessen (Logout). Attribution und Besucher-Cookie bleiben. */
export function reset(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* kein Speicher, nichts zu löschen */
  }
  log("reset");
}

/** Reichert ein Event mit allem an, was der Browser weiß. */
async function enrich(ev: TrackEvent): Promise<Record<string, unknown>> {
  const attr = readAttribution();
  const identity = readIdentity();
  const out: Record<string, unknown> = {
    ...ev,
    event_id: ev.event_id ?? newEventId(),
    url: ev.url ?? location.href,
    referrer: ev.referrer ?? document.referrer ?? "",
    occurred_at: ev.occurred_at ?? new Date().toISOString(),
    gclid: ev.gclid ?? attr.gclid,
    gbraid: ev.gbraid ?? attr.gbraid,
    wbraid: ev.wbraid ?? attr.wbraid,
    // Die drei jüngeren Kennungen sammelte die Attribution längst ein — sie
    // fielen nur hier aus dem Payload und kamen deshalb nie am Ziel an.
    ttclid: ev.ttclid ?? attr.ttclid,
    msclkid: ev.msclkid ?? attr.msclkid,
    epik: ev.epik ?? attr.epik,
    fbc: ev.fbc ?? buildFbc(attr),
    fbp: ev.fbp ?? fbp(),
    ga_client_id: ev.ga_client_id ?? gaClientId(),
    // Ohne Erlaubnis weder Cookie schreiben noch einen alten Wert mitschicken.
    visitor_id: currentVisitorId(),
    consent: ev.consent ?? consentState ?? undefined,
    external_id: ev.external_id ?? identity.external_id,
  };
  if (options?.shopId) out.shop_id = options.shopId;
  if (options?.environment) out.environment = options.environment;

  // Klartext niemals senden — der Collector weist ihn ohnehin ab.
  // Reihenfolge: Klartext im Event > Hash im Event > gespeicherte Identität.
  if (ev.email) out.em = await ensureHashed(ev.email, "email");
  else out.em = ev.em ?? identity.em;
  if (ev.phone) {
    // Zwei Hashes: Meta verlangt die Nummer ohne, Google mit Pluszeichen.
    out.ph = await hashPhone(ev.phone);
    out.ph_e164 = await hashPhoneE164(ev.phone);
  } else {
    out.ph = ev.ph ?? identity.ph;
    out.ph_e164 = ev.ph_e164 ?? identity.ph_e164;
  }
  delete out.email;
  delete out.phone;

  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** sendBeacon zuerst — es überlebt den Seitenwechsel (Klick auf „Kaufen“). */
function beacon(url: string, body: string): boolean {
  try {
    // text/plain ist CORS-safelisted → kein Preflight.
    if (navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) return true;
  } catch {
    /* Fallback unten */
  }
  try {
    void fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true });
    return true;
  } catch {
    return false;
  }
}

/** Ein Statuscode, mit dem die Proxy-Route sagt: „Der Weg trägt.“ 413 heißt nur: dieses Event war zu groß. */
function routeAlive(status: number): boolean {
  return status === 204 || status === 202 || status === 413;
}

/**
 * Erstes Event einer Sitzung über die Proxy-Route: per fetch, weil nur
 * fetch den Statuscode verrät. 404 (Route fehlt), 5xx oder ein
 * Transportfehler heißen: Der Weg über den eigenen Server trägt nicht —
 * dann direkt an den Collector, und die Sitzung merkt es sich.
 */
async function probe(body: string, fallback: string, type: unknown): Promise<void> {
  try {
    const res = await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
      keepalive: true,
    });
    if (routeAlive(res.status)) {
      rememberTransport("same-origin");
      log("gesendet (proxy)", type);
      return;
    }
    log("Proxy-Route antwortet mit", res.status, "— Rückfall auf den Collector");
  } catch (e) {
    log("Proxy-Route nicht erreichbar — Rückfall auf den Collector", e);
  }
  rememberTransport("fallback");
  beacon(fallback, body);
}

async function send(ev: TrackEvent): Promise<void> {
  if (!options) {
    console.warn("[trackdolphin] init() fehlt — Event verworfen");
    return;
  }
  const payload = await enrich(ev);
  const body = JSON.stringify(payload);
  const fallback = options.fallbackEndpoint;

  if (fallback && transport === "") {
    // Optimistisch: Nur dieses Event wartet auf die Antwort, alle weiteren
    // dürfen sofort raus.
    transport = "same-origin";
    await probe(body, fallback, payload.type);
    return;
  }

  const url = fallback && transport === "fallback" ? fallback : endpointUrl;
  if (beacon(url, body)) {
    log("gesendet", payload.type);
    return;
  }
  if (fallback && url !== fallback) {
    rememberTransport("fallback");
    beacon(fallback, body);
  }
}

/** Event senden (oder puffern, solange keine Einwilligung vorliegt). */
export function track(ev: TrackEvent): void {
  if (!consentGranted) {
    if (queue.length < (options?.queueLimit ?? 50)) queue.push(ev);
    log("gepuffert", ev.type);
    return;
  }
  void send(ev);
}

/** Bequeme Kurzformen. */
export const viewItem = (items: TrackEvent["items"], value?: number, currency = "EUR") =>
  track({ type: "view_item", items, value, currency });

export const addToCart = (items: TrackEvent["items"], value?: number, currency = "EUR") =>
  track({ type: "add_to_cart", items, value, currency });

export const beginCheckout = (value: number, currency = "EUR", items?: TrackEvent["items"]) =>
  track({ type: "begin_checkout", value, currency, items });

/**
 * Kauf im Browser. Für den Server-Kauf dieselbe `event_id` verwenden —
 * nur so dedupliziert Meta zwischen Pixel und CAPI.
 */
export const purchase = (ev: Omit<TrackEvent, "type">) => track({ ...ev, type: "purchase" });

/** Lead/Custom-Event (Leadgen — z. B. Probetraining, Kontaktformular). */
export const lead = (name: string, ev: Omit<TrackEvent, "type" | "custom_name"> = {}) =>
  track({ ...ev, type: "custom", custom_name: name });
