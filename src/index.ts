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
import {
  buildFbc,
  captureAttribution,
  captureTouch,
  fbp,
  gaClientId,
  readAttribution,
  readTouches,
  readVisitorId,
  sessionId,
  urlSignals,
  visitorId,
} from "./attribution.ts";
import { ensureHashed, hashEmail, hashName, hashPhone, hashPhoneE164 } from "./hash.ts";
import { newEventId, type ConsentState, type TrackEvent, type Traits } from "./types.ts";

import { buildTags } from "./enrichment.ts";
import { CMP_CHANGE_EVENTS, listenKlaro, listenTcf, readCmp, type CmpReading, type TcData } from "./cmp.ts";
import { clarityAdapter, upgradeClarity } from "./clarity.ts";
import { posthogAdapter, readPostHogSessionId } from "./posthog.ts";
import { sentryAdapter } from "./sentry.ts";
import { readAttribution as currentAttribution } from "./attribution.ts";
export * from "./types.ts";
export * from "./hash.ts";
export { captureAttribution, captureTouch, readAttribution, readTouches, readVisitorId, visitorId } from "./attribution.ts";
export type { Touchpoint } from "./attribution.ts";
export { deriveChannel, valueBand, buildTags, consentTag, sanitizeTagValue } from "./enrichment.ts";
export { upgradeClarity } from "./clarity.ts";
export { readPostHogSessionId } from "./posthog.ts";
export { readCmp, CMP_NAMES, type CmpName, type CmpReading } from "./cmp.ts";
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

/**
 * Die drei Modi aus `docs/drei-modi.md` — sie sagen, was VOR einer
 * Entscheidung passiert. Nach einer Entscheidung zählt die Entscheidung.
 *
 *   nach_einwilligung  Die Seite schweigt. Kein Ereignis, kein Cookie, kein Lesen.
 *   sammeln            Alles senden, was ohne Zugriff aufs Endgerät bekannt
 *                      ist; das Gerät selbst bleibt unangetastet.
 *   immer              Sofort mit Kennungen, Cookie gesetzt.
 *
 * Der Unterschied zwischen `sammeln` und `immer` ist NICHT die Datenmenge,
 * sondern der Zugriff aufs Endgerät (Paul, 11.9.2026: „wir speichern immer
 * alles, sodass auch Backfill möglich ist, aber leiten es nicht weiter."). Das
 * Tor zu Google und Meta sitzt hinter unserem Server, nicht hier.
 *
 * `sammeln` hiess bis zum 11.9.2026 `anonym` und bedeutete etwas anderes; der
 * alte Name wird als Eingabe noch verstanden, nicht mehr geschrieben.
 *
 * Die Liste steht hier und nicht in `@trackdolphin/consent-policy`, weil das
 * SDK als npm-Paket ohne Abhängigkeiten ausgeliefert wird.
 */
export const MODI = ["nach_einwilligung", "sammeln", "immer"] as const;
export type Modus = (typeof MODI)[number];

/**
 * Einen Wert auf einen Modus abbilden. Alles Unbekannte — `eigen`, ein
 * Tippfehler, ein Wert aus der Zukunft — wird `nach_einwilligung`: die strenge
 * Wahl, nicht die bequeme.
 */
export function normalizeModus(raw: unknown): Modus {
  if (raw === "anonym") return "sammeln";
  return (MODI as readonly unknown[]).includes(raw) ? (raw as Modus) : "nach_einwilligung";
}

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
   * Der Modus für diese Seite. Ohne Angabe fragt das SDK den Collector
   * (`<endpoint>/consent-banner`), weil nur der das Land der Besucherin
   * kennt; bis die Antwort da ist, gilt `nach_einwilligung`.
   *
   * Wer in `immer` misst, sollte den Modus hier NENNEN: Der
   * Consent-Mode-Default wird beim `init()` angesagt und lässt sich später
   * nicht mehr zurücknehmen, weil das Google-Tag ihn dann schon gelesen hat.
   */
  modus?: Modus;
  /**
   * Den Consent-Mode-Default ansagen (`gtag('consent','default', …)`) — je
   * Modus alles `denied` mit `wait_for_update` oder alles `granted`.
   *
   * Standard: an, solange kein fremdes Consent-Werkzeug im Fenster erkannt
   * wurde und noch niemand einen Default angesagt hat. Ohne Ansage verhält
   * sich ein Google-Tag wie eingewilligt und setzt Cookies; zwei
   * widersprechende Ansagen wären aber schlimmer als keine.
   */
  consentDefault?: boolean;
  /**
   * Ohne Einwilligung nichts senden? Events werden dann gepuffert und beim
   * Freischalten nachgesendet. Server-seitige Events sind davon unberührt.
   *
   * Seit 0.4.0 nur noch eine Kurzform für `modus`: `true` entspricht
   * `nach_einwilligung`, ein ausdrückliches `false` entspricht `immer`. Wer
   * beides setzt, bekommt `modus`.
   */
  requireConsent?: boolean;
  /**
   * Das Besucher-Cookie (`_td_vid`) erst schreiben und `visitor_id` erst
   * mitschicken, wenn `ad_storage` oder `analytics_storage` gewährt wurde.
   * Standard false: Das Cookie ist rein zufällig und first-party; wer es
   * trotzdem an die Einwilligung binden will (oder muss), schaltet hier um.
   */
  visitorCookieRequiresConsent?: boolean;
  /**
   * Trackdolphin Consent laden: den eigenen Banner des Projekts, wie er im
   * Dashboard unter Consent → Banner veröffentlicht ist. Das SDK holt die
   * Konfiguration vom Collector (`<endpoint>/consent-banner`), legt sie als
   * `window.__tdConsentConfig` ab und lädt die Laufzeit (Vorgabe
   * `https://trackdolphin.com/consent/td-consent.js`, mit `runtimeUrl` auch
   * von der eigenen Domain). Jede Entscheidung geht als Nachweis an
   * `<endpoint>/consent`. Ohne veröffentlichte Fassung passiert nichts.
   */
  consent?: boolean | { runtimeUrl?: string };
  /** Maximale Größe der Warteschlange (Schutz vor Endlos-Puffern). */
  queueLimit?: number;
  /**
   * Umgebung dieser Einbindung (z. B. „staging“ auf der Testinstanz). Wird
   * jedem Event mitgegeben; ohne Angabe füllt der Collector „production“.
   */
  environment?: string;
  /**
   * Microsoft Clarity mit unseren Custom Tags anreichern, sofern der Shop es
   * selbst eingebunden hat (`window.clarity`). Wir laden Clarity NICHT — wir
   * beschriften nur, was ohnehin läuft, damit sich Aufzeichnungen nach
   * Werbekanal, Kampagne und Bestellwert filtern lassen. Standard: an.
   * Es werden ausschließlich nicht-personenbezogene Werte gesetzt.
   */
  clarity?: boolean;
  /**
   * Beim Kauf `clarity("upgrade")` rufen, damit Clarity diese Sitzung sicher
   * aufzeichnet statt sie zu stichproben (greift ab 100.000 Sitzungen je
   * Projekt und Tag). Standard: aus — der Aufruf erhöht die
   * Aufzeichnungstiefe, und das ist eine Entscheidung des Shopbetreibers.
   */
  clarityUpgradeOnPurchase?: boolean;
  /**
   * PostHog mit denselben Merkmalen als Super-Properties versehen, sofern der
   * Shop PostHog selbst eingebunden hat. Zusätzlich wird — nur wenn PostHog
   * fertig geladen ist UND eine Aufzeichnung läuft — dessen Sitzungskennung an
   * unsere Events gehängt, damit sich aus dem Dashboard in die Aufzeichnung
   * springen lässt. Standard: an.
   */
  posthog?: boolean;
  /**
   * Sentry-Fehler mit denselben Merkmalen versehen, sofern der Shop Sentry
   * selbst eingebunden hat. Damit lässt sich in der Fehlersuche danach
   * filtern, welcher Kanal ein Problem trifft. Standard: an.
   */
  sentry?: boolean;
  debug?: boolean;
}

/** Eingabe für `identify()` — Klartext, wird lokal gehasht. */
export interface IdentifyInput {
  email?: string;
  phone?: string;
  /**
   * Der GANZE Name der Person im Klartext — Vor- und Nachname zusammen, so wie
   * die Anwendung ihn hat. Gültig wie eh und je; wer schon so aufruft, muss
   * nichts ändern.
   *
   * Er geht an keine Werbeplattform (dorthin gehen ausschließlich Hashes) und
   * verlässt den Browser NUR, wenn `setConsent()` ausdrücklich eine
   * Einwilligung mit Speicher-Erlaubnis gesetzt hat. Ohne diese Entscheidung
   * bleibt er hier liegen; die Hashes gehen wie bisher raus.
   */
  name?: string;
  /**
   * Vor- und Nachname getrennt. Wer sie hat, gibt sie hier: Daraus entstehen
   * die Match-Signale `fn`/`ln` für Google, Meta und Pinterest, und in der
   * Personenansicht steht ein Name statt eines Hashes.
   *
   * Fehlt `name`, bilden wir ihn aus beiden („Anna" + „Berg" → „Anna Berg").
   * Der umgekehrte Weg wird NICHT gegangen: Aus einem ganzen Namen lassen sich
   * Vor- und Nachname nicht zuverlässig schneiden. „van der Berg" hat drei
   * Wörter im Nachnamen, „Maria Anna" zwei im Vornamen, und in manchen
   * Schreibweisen steht der Nachname vorn. Wer da rät, schickt still falsche
   * Hashes an die Werbeplattformen und einen falschen Namen ins Dashboard —
   * und beides fällt niemandem auf. Lieber kein `fn`/`ln` als ein falsches.
   */
  firstName?: string;
  lastName?: string;
  /** Stabile Kundenkennung aus dem eigenen System (Kundennummer, User-ID). */
  externalId?: string;
  traits?: Traits;
}

/**
 * Was von `identify()` DAUERHAFT im Browser bleibt: nur Hashes und die
 * Kennung. Der Klartext aus `email`/`name` wandert bewusst NICHT in den
 * localStorage — er lebt nur in dieser Seitenlaufzeit (siehe `contact`), und
 * ein XSS auf der Seite fände im Speicher weiterhin nichts Lesbares.
 */
interface StoredIdentity {
  em?: string;
  ph?: string;
  ph_e164?: string;
  /**
   * Vor- und Nachname als Hash. Sie dürfen mit den anderen Match-Signalen in
   * den Speicher: Ein SHA-256 ist kein lesbarer Name, und ohne ihn hätte jedes
   * Ereignis NACH dem identify ein Match-Signal weniger als das identify
   * selbst — genau die Ereignisse also, die zählen (der Kauf).
   */
  fn?: string;
  ln?: string;
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
/**
 * Der Modus dieser Seite. Vorgabe ist der strengste: Solange niemand etwas
 * anderes gesagt hat (Aufrufer oder Collector), schweigt die Seite.
 */
let modus: Modus = "nach_einwilligung";
/** Hat der Aufrufer den Modus genannt? Dann darf die Antwort des Collectors ihn nicht überstimmen. */
let modusGesetzt = false;
/** Der zuletzt per `setConsent()` gesetzte Zustand; null = die Anwendung hat nie gerufen. */
let consentState: ConsentState | null = null;
/** Der letzte Stand aus `__tcfapi`, falls ein TCF-Werkzeug im Fenster ist. */
let tcData: TcData | null = null;
/**
 * Klartext-Kontaktdaten aus `identify()` — Name und E-Mail für die
 * Personenansicht im Dashboard.
 *
 * Bewusst nur im Arbeitsspeicher dieser Seite, nicht im localStorage: Sie
 * hängen an EINEM Event (dem identify), nicht an jedem Seitenaufruf. Wer sie
 * über Seitenwechsel hinweg gemeldet haben will, ruft `identify()` erneut auf
 * — das ist ohnehin der Aufruf, den eine Anwendung nach dem Login macht.
 */
let contact: { email?: string; name?: string; firstName?: string; lastName?: string } = {};
const queue: TrackEvent[] = [];

function log(...args: unknown[]): void {
  if (options?.debug) console.info("[trackdolphin]", ...args);
}

/** Schon gemeldete Fehlerarten — eine Warnung je Art und Seitenaufruf. */
const warned = new Set<string>();

/**
 * Ein verschluckter Fehler soll trotzdem auffallen — aber nur einmal je Art.
 * Ein Tracking-Fehler in einer Schleife (jedes Event einer Seite) darf weder
 * die Konsole noch das Fehler-Monitoring des Shops fluten.
 */
function warnOnce(where: string, error: unknown): void {
  if (!warned.has(where)) {
    warned.add(where);
    console.warn(`[trackdolphin] ${where} übersprungen:`, error);
  }
  log(where, "übersprungen", error);
}

/**
 * Jeder öffentliche Einstieg läuft hierdurch. Zusage an die einbindende
 * Anwendung: Das SDK wirft nie. Ein fehlendes `crypto.subtle` (unsicherer
 * Kontext, alte WebView), ein `<iframe sandbox>` ohne Cookie-Zugriff oder
 * ein blockierter Speicher kosten dann ein Event — nie den Kauf, in dessen
 * Klickpfad das Event steckt.
 */
function guard<T>(where: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    warnOnce(where, e);
    return fallback;
  }
}

/** Hashen, das nichts kostet außer dem Feld selbst. */
async function safeHash(where: string, hash: () => Promise<string>): Promise<string | undefined> {
  try {
    return await hash();
  } catch (e) {
    warnOnce(where, e);
    return undefined;
  }
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

/**
 * Fremde Werkzeuge mit dem beschriften, was wir wissen und sie nie wissen können.
 *
 * Läuft bei jedem Anlass neu: beim `init()` (der Kanal steht dann schon), nach
 * der Einwilligungsentscheidung (Clarity und PostHog werden oft erst dann
 * geladen) und beim Kauf (Wertband). Ist ein Werkzeug nicht im Shop, passiert
 * für dieses nichts.
 *
 * Die Merkmale werden EINMAL gebaut und an alle Adapter gegeben — nur das
 * Schreiben unterscheidet sich je Anbieter, nicht das Vokabular.
 *
 * Solange die Seite schweigt, beschriften wir nichts — dieselbe Linie wie
 * bei den Events.
 */
function syncEnrichment(extra: { purchaseValue?: number } = {}): void {
  if (schweigt()) return;
  guard(
    "enrichment",
    () => {
      const tags = buildTags({ attribution: currentAttribution(), consent: decidedConsent(), ...extra });
      if (options?.clarity !== false) clarityAdapter.apply(tags);
      if (options?.posthog !== false) posthogAdapter.apply(tags);
      if (options?.sentry !== false) sentryAdapter.apply(tags);
    },
    undefined,
  );
}

/**
 * Welcher Modus gilt, bevor der Collector geantwortet hat.
 *
 * `requireConsent` bleibt als Kurzform gültig, damit bestehende Einbindungen
 * nicht umschreiben müssen. Wer NICHTS davon setzt, bekommt seit 0.4.0 den
 * strengen Modus: Bis 0.3.x sendete das SDK in diesem Fall sofort und mit
 * Kennungen, und genau das ist die Entscheidung, die ein Händler treffen
 * soll — nicht die Vorgabe einer Bibliothek.
 */
function resolveModus(opts: InitOptions): { modus: Modus; gesetzt: boolean } {
  if (opts.modus) {
    const m = normalizeModus(opts.modus);
    if (m !== "nach_einwilligung" || opts.modus === "nach_einwilligung") return { modus: m, gesetzt: true };
  }
  if (opts.requireConsent === true) return { modus: "nach_einwilligung", gesetzt: true };
  if (opts.requireConsent === false) return { modus: "immer", gesetzt: true };
  return { modus: "nach_einwilligung", gesetzt: false };
}

export function init(opts: InitOptions): void {
  // Erst die Einstellungen, dann alles, was den Browser anfasst: Fällt der
  // zweite Teil aus, sendet das SDK trotzdem — nur ohne Attribution.
  options = { queueLimit: 50, visitorCookieRequiresConsent: false, ...opts };
  const m = resolveModus(opts);
  modus = m.modus;
  modusGesetzt = m.gesetzt;
  // Ein neues init() ist ein neuer Anfang: Was eine frühere Einbindung per
  // setConsent() gesetzt hat, gilt nicht weiter — sonst entschiede der
  // vorige Aufruf darüber, ob diese Seite schweigt.
  consentState = null;
  erfasst = false;
  // ZUERST der Consent-Mode-Default, vor allem anderen: Er muss vor dem
  // Google-Tag der Seite stehen, sonst verhält das sich wie eingewilligt und
  // setzt Cookies. Später ist er nicht mehr nachzuholen.
  guard("consent-default", announceConsentDefault, undefined);
  guard(
    "init",
    () => {
      endpointUrl = resolveEndpoint(options!.endpoint);
      // Ohne Rückfall gibt es nichts zu entscheiden — dann bleibt alles beim Ziel.
      transport = options!.fallbackEndpoint ? readTransport() : "";
      visitorMode = options!.visitorId ?? (sameOrigin(endpointUrl) ? "server" : "client");
      // Attribution ist ein Cookie-Schreiber. Ohne Erlaubnis wird er nicht
      // angefasst; nach einer Entscheidung holt `captureSpaeter()` es nach.
      captureSpaeter();
      log("initialisiert", endpointUrl, "· Modus:", modus, "· Besucherkennung:", visitorMode);
    },
    undefined,
  );
  guard("cmp", watchCmp, undefined);
  // Den Modus holen wir auch ohne eigenen Banner: Ohne ihn bliebe ein Shop
  // ausserhalb der EU beim strengsten Verhalten, obwohl er im Dashboard etwas
  // anderes gewählt hat.
  if (options.consent || !modusGesetzt) guard("consent-banner", loadConsentBanner, undefined);
  syncEnrichment();
}

/**
 * Der Consent-Mode-Default — der Satz, den die Seite sagt, bevor jemand
 * entschieden hat.
 *
 * WARUM überhaupt: Ohne Ansage verhält sich ein Google-Tag wie eingewilligt
 * und setzt Cookies (Googles eigene Hilfe). Für den EWR wertet Google
 * fehlende Signale umgekehrt als nicht eingewilligt und nutzt die Daten gar
 * nicht. Eine ausdrückliche Ansage ist deshalb in JEDEM Modus besser als
 * keine; sie unterscheidet sich nur im Inhalt.
 *
 * WANN NICHT: wenn der Aufrufer es abstellt, wenn schon jemand einen Default
 * angesagt hat, oder wenn ein fremdes Consent-Werkzeug im Fenster steht — das
 * sagt seinen eigenen an, und zwei widersprechende sind schlimmer als keiner.
 */
function announceConsentDefault(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  if (options?.consentDefault === false) return;
  const dl = Array.isArray(w.dataLayer) ? (w.dataLayer as unknown[]) : ((w.dataLayer = []) as unknown[]);
  for (const e of dl) {
    const a = e as { [k: number]: unknown } | null;
    if (a && a[0] === "consent" && a[1] === "default") return;
  }
  if (options?.consentDefault !== true) {
    // Googles eigener Zustandsspeicher zählt wie ein Default im dataLayer.
    const ics = (w.google_tag_data as { ics?: { entries?: Record<string, unknown> } } | undefined)?.ics?.entries;
    if (ics && ics.ad_storage) return;
    if (cmpReading().cmp) return;
  }
  // Chris' Haken (docs/drei-modi.md): Innerhalb von Modus 3 sagt nur die
  // clientseitige Fassung `granted` an. „Nur serverseitig" liefert vollständig
  // weiter, fasst das Endgerät aber nicht an — und `granted` anzusagen, ohne
  // selbst ein Cookie zu setzen, hiesse, das Google-Tag setzte stattdessen
  // seins. Dann wäre „nur serverseitig" serverseitig plus ein fremdes Cookie.
  const clientseitig = misstClientseitig();
  const wert = clientseitig ? "granted" : "denied";
  const signals: Record<string, unknown> = {
    ad_storage: wert,
    analytics_storage: wert,
    ad_user_data: wert,
    ad_personalization: wert,
  };
  // `wait_for_update` nur bei „denied": Es gibt dem Banner die Zeit, eine
  // gespeicherte Entscheidung nachzureichen. Bei „granted" gäbe es nichts zu warten.
  if (!clientseitig) signals.wait_for_update = 500;
  const gtag = typeof w.gtag === "function" ? (w.gtag as (...a: unknown[]) => void) : null;
  // Dieselbe Form wie im Standard-Snippet von Google: gtag schiebt sein
  // `arguments`-Objekt in den dataLayer, kein Array.
  if (gtag) gtag("consent", "default", signals);
  else dl.push(argumentsOf("consent", "default", signals));
  log("consent default", modus, signals);
}

/** Nachbildung von `gtag`: Google liest `dataLayer.push(arguments)`, kein Array. */
function argumentsOf(..._args: unknown[]): IArguments {
  // eslint-disable-next-line prefer-rest-params
  return arguments;
}

/**
 * Attribution und Kontaktpunkte einsammeln — beides schreibt Cookies und darf
 * das nur, wenn der Modus oder eine Entscheidung es erlaubt. Läuft beim
 * `init()` und noch einmal, sobald jemand zustimmt.
 */
let erfasst = false;
function captureSpaeter(): void {
  if (erfasst || !kennungenErlaubt()) return;
  erfasst = true;
  captureAttribution();
  captureTouch();
}

export const CONSENT_RUNTIME_URL = "https://trackdolphin.com/consent/td-consent.js";

/**
 * Die Auskunft des Collectors holen: den Modus für diese Besucherin und, wenn
 * `InitOptions.consent` es will, die veröffentlichte Fassung des Banners.
 *
 * Der Banner selbst spricht nie mit dem Netz; Konfiguration und Nachweis
 * laufen über das SDK, das ohnehin mit dem Collector spricht. Ein 404 heisst:
 * keine veröffentlichte Fassung — der Modus steht trotzdem darin.
 */
function loadConsentBanner(): void {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") return;
  const w = window as unknown as Record<string, unknown>;
  if (w.__tdConsentConfig || document.getElementById("td-cm-runtime")) return;
  const base = endpointUrl.replace(/\/+$/, "");
  const project = options?.shopId ? `?project=${encodeURIComponent(options.shopId)}` : "";
  fetch(`${base}/consent-banner${project}`, { credentials: "omit" })
    // Auch ein 404 wird gelesen: Er trägt den Modus, nur keinen Banner.
    .then((r) => (r.ok || r.status === 404 ? r.json().catch(() => null) : null))
    .then((cfg: { schema?: number; modus?: unknown } | null) => {
      if (!cfg) return;
      // Der Modus kommt auch aus einer Antwort ohne Banner: Ein Shop ohne
      // veröffentlichte Fassung hat trotzdem eine Regel.
      setModusVomCollector(cfg.modus);
      if (cfg.schema !== 1 || !options?.consent) return;
      w.__tdConsentConfig = cfg;
      const runtime = typeof options?.consent === "object" && options.consent.runtimeUrl ? options.consent.runtimeUrl : CONSENT_RUNTIME_URL;
      const script = document.createElement("script");
      script.id = "td-cm-runtime";
      script.src = runtime;
      script.defer = true;
      document.head.appendChild(script);
    })
    .catch(() => {});
  document.addEventListener("trackdolphin_consent", (e) => {
    const decision = (e as CustomEvent).detail as { at?: string } | null;
    if (!decision) return;
    // Nur eine NEUE Entscheidung ist ein Nachweis: Der Banner meldet die
    // gespeicherte beim Laden jeder Seite erneut (für die Brücken), mit
    // ihrem alten Zeitstempel. Die ginge sonst bei jedem Aufruf als Zeile in
    // den Nachweis.
    const alter = Date.now() - Date.parse(decision.at ?? "");
    if (!(alter >= 0 && alter < 15_000)) return;
    const body: Record<string, unknown> = {
      decision,
      lang: (document.documentElement.lang || "").slice(0, 2),
      page: location.origin + location.pathname,
    };
    if (options?.shopId) body.project_id = options.shopId;
    const vid = (document.cookie.match(/(?:^|;\s*)_td_vid=([^;]+)/) ?? [])[1];
    if (vid) body.visitor_id = decodeURIComponent(vid);
    fetch(`${base}/consent`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  });
}

/**
 * Das Consent-Werkzeug im Blick behalten. Kein Polling: Wir hängen uns an die
 * Ereignisse, die die Werkzeuge selbst auslösen, und an den TCF-Listener.
 * Dazu kommt ein Blick bei jedem `track()`, solange die Warteschlange wartet —
 * für Werkzeuge, die gar kein Ereignis feuern.
 */
function watchCmp(): void {
  if (typeof addEventListener !== "function") return;
  for (const name of CMP_CHANGE_EVENTS) {
    addEventListener(name, () => applyCmp());
    // Shopify feuert an document, die WP Consent API ebenso; beides kostet
    // nichts, wenn es das Ereignis nie gibt.
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener(name, () => applyCmp());
    }
  }
  listenTcf((tc) => {
    tcData = tc;
    applyCmp();
  });
  beobachteKlaro();
  // `klaroLoadWatchers` ist KEINE Klaro-Schnittstelle, sondern der Ladehaken,
  // den primetime-fitness.de in seiner app.html nach dem Laden von klaro.js
  // aufruft (und den KIProtect-Einbindungen gern so nachbauen). Führt die Seite
  // so eine Liste, hängen wir uns an; anlegen tun wir sie nicht, weil ein
  // passives SDK keine fremden Globals erfindet. Ohne Liste greift der
  // nächste Blick ins Fenster (`cmpReading`).
  const w = globalThis as unknown as { klaroLoadWatchers?: unknown };
  if (!klaroBeobachtet && Array.isArray(w.klaroLoadWatchers)) {
    (w.klaroLoadWatchers as (() => void)[]).push(() => {
      beobachteKlaro();
      applyCmp();
    });
  }
  applyCmp();
}

/**
 * Klaro meldet Änderungen nur an Beobachter seines ConsentManagers (siehe
 * `listenKlaro` in cmp.ts), und den gibt es erst, wenn klaro.js geladen ist
 * — oft nach dem SDK. Deshalb wird die Anmeldung so lange bei jedem Blick
 * ins Fenster nachgeholt, bis sie einmal geklappt hat.
 */
let klaroBeobachtet = false;
function beobachteKlaro(): void {
  if (klaroBeobachtet) return;
  klaroBeobachtet = listenKlaro(() => applyCmp());
}

/**
 * Was das Werkzeug gerade sagt. Jedes Mal frisch gelesen, weil ein Banner
 * seinen Zustand ändert, ohne uns zu fragen, und ein Blick ins Fenster billig
 * ist. Fällt die Erkennung aus, gilt „kein Werkzeug" — nie „alles erteilt".
 */
function cmpReading(): CmpReading {
  guard("cmp-klaro", beobachteKlaro, undefined);
  return guard("cmp", () => readCmp(tcData), { cmp: "", state: null, decided: false } as CmpReading);
}

/**
 * Der Zustand mit Herkunft, wie er ins Ereignis geht.
 *
 * Reihenfolge: Was die Anwendung per `setConsent()` gesetzt hat, gewinnt
 * (`api`) — sie trägt die Verantwortung und kennt ihr Banner besser als
 * unsere Erkennung. Sonst die Entscheidung des Werkzeugs (`cmp`). Sonst eine
 * Voreinstellung (`default`): mit den Signalen eines Consent-Mode-`default`,
 * falls es eins gibt, ohne sonst. In beiden Fällen sagt der Schlüssel, dass
 * hier niemand entschieden hat; die Behauptung „alles erteilt" macht das SDK
 * seit 0.2.1 nicht mehr.
 */
function currentConsent(): ConsentState {
  const r = cmpReading();
  if (consentState) return { ...consentState, source: consentState.source ?? "api", cmp: consentState.cmp ?? r.cmp };
  if (r.state && r.decided) return { ...r.state, source: "cmp", cmp: r.cmp };
  if (r.state) return { ...r.state, source: "default", cmp: r.cmp };
  return { source: "default", cmp: r.cmp };
}

/**
 * Nur eine ENTSCHEIDUNG zählt als Einwilligung: die der Anwendung oder die
 * des Werkzeugs. Eine Voreinstellung gibt weder Klartext noch das Cookie
 * frei, egal was in ihren Signalen steht.
 */
function decidedConsent(): ConsentState | null {
  const c = currentConsent();
  return c.source === "default" ? null : c;
}

/**
 * Misst diese Seite auch CLIENTSEITIG — eigenes Cookie und
 * Consent-Mode-Default `granted`?
 *
 * Die Reihenfolge ist dieselbe wie in `clientseitigMessen`
 * (packages/consent-policy): erst der Modus, dann die Einstellung. Das SDK
 * kann jenes Paket nicht laden (es soll ohne Abhängigkeiten in jede Seite
 * passen), führt die Tabelle also in seiner eigenen Sprache — so wie das
 * Banner-Paket und das WooCommerce-Plugin (docs/drei-modi.md).
 *
 * `visitorCookieRequiresConsent` ist der Haken, gespiegelt: `true` heisst
 * „nur serverseitig", und das ist die Vorgabe von Modus 3.
 */
function misstClientseitig(): boolean {
  return modus === "immer" && options?.visitorCookieRequiresConsent !== true;
}

/**
 * Dürfen Kennungen mitgehen und Cookies geschrieben werden? Nach einer
 * Entscheidung sagt das die Entscheidung, davor der Modus: nur `immer` misst
 * ungefragt mit Kennungen.
 */
function kennungenErlaubt(): boolean {
  const c = decidedConsent();
  if (c) return storageGranted(c);
  return modus === "immer";
}

/**
 * Modus 1 ohne erlaubende Entscheidung: Die Seite schweigt — kein Ereignis
 * auf der Leitung, kein Cookie, kein Speicher. Ereignisse warten solange im
 * Arbeitsspeicher und gehen nach dem Ja hinaus; so fehlt der erste
 * Seitenaufruf nicht, sobald jemand zustimmt.
 */
function schweigt(): boolean {
  return modus === "nach_einwilligung" && !kennungenErlaubt();
}

/** Wartende Ereignisse loslassen, sobald Modus oder Entscheidung es erlauben. */
function warteschlangeLoslassen(): void {
  if (schweigt() || queue.length === 0) return;
  const pending = queue.splice(0, queue.length);
  log("Warteschlange läuft an:", pending.length);
  for (const ev of pending) void send(ev);
}

/**
 * Der Modus, wie ihn der Collector für diese Besucherin ausgerechnet hat.
 * Ein vom Aufrufer genannter Modus bleibt stehen: Er hat den
 * Consent-Mode-Default schon geprägt, und zwei verschiedene Wahrheiten auf
 * einer Seite wären schlimmer als eine grobe.
 */
function setModusVomCollector(raw: unknown): void {
  if (modusGesetzt || typeof raw !== "string") return;
  modus = normalizeModus(raw);
  log("Modus vom Collector:", modus);
  if (modus === "immer") {
    // Der Default steht schon auf „denied": Ein Google-Tag hat ihn womöglich
    // gelesen. Nachträglich „granted" zu behaupten wäre eine Entscheidung,
    // die niemand getroffen hat. Wer in „immer" misst, nennt den Modus beim
    // init(); dann stimmt der Default von der ersten Zeile an.
    log("Modus immer kam zu spaet fuer den Consent-Mode-Default: beim init() nennen");
  }
  captureSpaeter();
  warteschlangeLoslassen();
  syncEnrichment();
}

/**
 * Sagt das Werkzeug inzwischen ja, läuft die Warteschlange an — dieselbe
 * Wirkung wie `setConsent()` aus dem Banner-Callback, nur ohne dass der
 * Betreiber die Brücke selbst bauen muss. Ein Nein ändert nichts: Dann bleibt
 * es bei dem, was `requireConsent` vorgibt.
 */
function applyCmp(): void {
  if (schweigt()) return;
  captureSpaeter();
  warteschlangeLoslassen();
  syncEnrichment();
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
  guard(
    "setConsent",
    () => {
      consentState = typeof granted === "boolean" ? { ...(granted ? ALL_GRANTED : ALL_DENIED) } : { ...granted };
      // Wer hier ruft, hat entschieden — die Herkunft ist `api`, es sei denn,
      // die Anwendung sagt selbst, dass sie nur ein Werkzeug durchreicht.
      consentState.source ??= "api";
      log("consent", consentState, "· Warteschlange:", queue.length);
      if (schweigt()) return;
      captureSpaeter();
      warteschlangeLoslassen();
      // Die Werkzeuge werden typischerweise genau jetzt erst geladen — nachfassen.
      syncEnrichment();
    },
    undefined,
  );
}

/**
 * Darf Klartext (Name, E-Mail) den Browser verlassen?
 *
 * Nur nach einer AUSDRÜCKLICHEN Entscheidung, die Speicher gewährt —
 * dieselbe Prüfung wie beim Besucher-Cookie, aber ohne Schalter, der sie
 * abschalten könnte. `consentState === null` heißt „es wurde nie gefragt",
 * und das ist etwas anderes als „erlaubt": Ohne `setConsent()` geht also
 * KEIN Klartext raus, während Hashes und Ereignis wie bisher gehen.
 */
function contactAllowed(): boolean {
  const c = decidedConsent();
  return c !== null && storageGranted(c);
}

/**
 * Sieht der Wert aus wie eine E-Mail? Der Collector prüft `contact_email`
 * gegen dasselbe Muster und weist das GANZE Event mit 400 ab, wenn es nicht
 * passt. Eine krumme Eingabe darf den Kauf nicht kosten — lieber ohne Namen
 * als ohne Ereignis.
 */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

/** Darf das Besucher-Cookie heute geschrieben und mitgeschickt werden? */
function visitorCookieAllowed(): boolean {
  // Im Modus „sammeln" nie, egal wie der Schalter steht: Das Cookie dürfte
  // weder geschrieben noch gelesen werden, und eine Kennung ohne Cookie gibt
  // es nicht.
  if (!kennungenErlaubt()) return false;
  if (!options?.visitorCookieRequiresConsent) return true;
  const c = decidedConsent();
  return c !== null && storageGranted(c);
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
 * Person erkennen (Login, Newsletter, Checkout-Formular). E-Mail, Telefon und
 * Name werden hier gehasht; dauerhaft gespeichert werden nur die Hashes und
 * `externalId`. Ab jetzt trägt jedes Event `em`, `ph`, `ph_e164`, `fn`, `ln`
 * und `external_id`, sofern es sie nicht selbst mitbringt. Einmalig geht ein
 * Event `identify` mit den `traits` raus — daraus bildet die App Kohorten.
 *
 * `name`, `firstName`, `lastName` und `email` gehen ZUSÄTZLICH im Klartext
 * mit, aber nur am identify-Event und nur nach einer ausdrücklichen
 * Einwilligung mit Speicher-Erlaubnis (`setConsent()`). Damit steht im
 * Dashboard ein Name statt einer Zeichenkette; die Hash-Felder daneben
 * bleiben unberührt.
 */
export async function identify(input: IdentifyInput): Promise<void> {
  // Diese Funktion wird oft im Absende-Handler eines Formulars abgewartet.
  // Sie lehnt deshalb nie ab: Ein fehlgeschlagener Hash kostet die Zuordnung,
  // nicht den Abschluss. Was sich hashen ließ, wird trotzdem gespeichert.
  const next: StoredIdentity = { ...guard("identify", readIdentity, {} as StoredIdentity) };
  if (input.email) {
    const em = await safeHash("identify(email)", () => hashEmail(input.email!));
    if (em) next.em = em;
  }
  if (input.phone) {
    // Zwei Hashes: Meta verlangt die Nummer ohne, Google mit Pluszeichen.
    const ph = await safeHash("identify(phone)", () => hashPhone(input.phone!));
    const e164 = await safeHash("identify(phone)", () => hashPhoneE164(input.phone!));
    if (ph) next.ph = ph;
    if (e164) next.ph_e164 = e164;
  }
  // Vor- und Nachname als Match-Signal. `hashName` liefert leer, wenn nach der
  // Normalisierung nichts übrig ist (nur ein Titel, nur Ziffern) — dann bleibt
  // das Feld weg, statt den immer gleichen Hash des Leerstrings zu senden.
  if (input.firstName) {
    const fn = await safeHash("identify(firstName)", () => hashName(input.firstName!));
    if (fn) next.fn = fn;
  }
  if (input.lastName) {
    const ln = await safeHash("identify(lastName)", () => hashName(input.lastName!));
    if (ln) next.ln = ln;
  }
  if (input.externalId) next.external_id = input.externalId;
  // Klartext getrennt vom gespeicherten Teil: Er geht in den flüchtigen
  // Zustand, nicht in den localStorage, und ob er den Browser verlässt,
  // entscheidet erst `enrich()` anhand der Einwilligung.
  if (input.email) contact.email = input.email.trim();
  if (input.firstName) contact.firstName = input.firstName.trim();
  if (input.lastName) contact.lastName = input.lastName.trim();
  // Der ganze Name: genommen, wenn er da ist, sonst aus den Teilen gebaut. Nur
  // diese Richtung — sie ist eindeutig. Die Gegenrichtung (ganzen Namen
  // zerlegen) wäre geraten, siehe IdentifyInput.
  const ganzerName = input.name?.trim() || [input.firstName, input.lastName].map((t) => t?.trim()).filter(Boolean).join(" ");
  if (ganzerName) contact.name = ganzerName;
  guard("identify", () => writeIdentity(next), undefined);
  log("identify", Object.keys(next));
  track({ type: "identify", traits: input.traits });
}

/** Identität vergessen (Logout). Attribution und Besucher-Cookie bleiben. */
export function reset(): void {
  guard(
    "reset",
    () => {
      try {
        localStorage.removeItem(IDENTITY_KEY);
      } catch {
        /* kein Speicher, nichts zu löschen */
      }
      // Der Klartext gehört zur Identität und muss mit ihr verschwinden —
      // sonst trüge das nächste identify eines anderen Nutzers am selben
      // Gerät noch den Namen des vorigen.
      contact = {};
      for (const a of [clarityAdapter, posthogAdapter, sentryAdapter]) a.reset();
      log("reset");
    },
    undefined,
  );
}

/** Reichert ein Event mit allem an, was der Browser weiß. */
async function enrich(ev: TrackEvent): Promise<Record<string, unknown>> {
  /**
   * Darf dieses Ereignis das Endgerät lesen? Im Modus „sammeln" nicht: Dann
   * gibt es keine Besucherkennung, keine Sitzung, keine Kontaktliste und
   * keine gespeicherte Identität — nicht weil wir sie entfernen, sondern weil
   * nichts da ist, aus dem sie käme. Alles andere geht vollständig mit
   * (Adresse samt Parametern, Referrer, Produkte, Wert): Das Tor zu Google
   * und Meta sitzt hinter unserem Server, nicht hier.
   */
  const geraet = kennungenErlaubt();
  const attr = geraet ? readAttribution() : urlSignals();
  const identity = geraet ? readIdentity() : {};
  /**
   * PostHogs Sitzungskennung, wenn PostHog fertig geladen ist UND wirklich
   * aufzeichnet. Damit lässt sich später aus einer verlorenen Conversion in die
   * passende Aufzeichnung springen. Fehlt eine der beiden Bedingungen, bleibt
   * das Feld weg — ein Link auf eine nicht existierende Aufzeichnung wäre
   * schlimmer als keiner.
   */
  const posthogSession = options?.posthog !== false && geraet ? readPostHogSessionId() : null;
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
    // OpenAI/ChatGPT Ads. Noch ohne Ziel — aber ohne diese Zeile stünde die
    // Kennung nur im Attributions-Cookie des Browsers und wäre für den
    // Server nie zu sehen; nachträglich einsammeln lässt sie sich nicht.
    oppref: ev.oppref ?? attr.oppref,
    // `_fbc` baut Meta aus einer `fbclid`; ohne Gerätezugriff zählt allein
    // die aus dieser Adresse, nicht ein Cookie von vorhin.
    fbc: ev.fbc ?? buildFbc(attr, geraet),
    // `_fbp` und die GA-Client-ID gibt es NUR als Cookie.
    fbp: ev.fbp ?? (geraet ? fbp() : undefined),
    ga_client_id: ev.ga_client_id ?? (geraet ? gaClientId() : undefined),
    // Ohne Erlaubnis weder Cookie schreiben noch einen alten Wert mitschicken.
    visitor_id: currentVisitorId(),
    // Immer mit Herkunft: Ein Zustand am Ereignis selbst ist eine Entscheidung
    // der Anwendung (`api`), sonst gilt, was Werkzeug oder Voreinstellung sagen.
    consent: ev.consent
      ? { ...ev.consent, source: ev.consent.source ?? "api", cmp: ev.consent.cmp ?? cmpReading().cmp }
      : currentConsent(),
    external_id: ev.external_id ?? identity.external_id,
    // Die Kontaktliste — bis hierher blieb sie im Cookie, und utm_source
    // eines Browser-Ereignisses kam nie am Server an.
    touches: ev.touches ?? (geraet ? readTouches() : undefined),
    session_id: ev.session_id ?? (geraet ? sessionId() : undefined),
  };
  if (options?.shopId) out.shop_id = options.shopId;
  if (options?.environment) out.environment = options.environment;
  if (posthogSession) out.posthog_session_id = posthogSession;

  // Klartext niemals senden — der Collector weist ihn ohnehin ab.
  // Reihenfolge: Klartext im Event > Hash im Event > gespeicherte Identität.
  // Scheitert das Hashen, geht das Event ohne diese Felder raus: schlechteres
  // Matching, aber die Conversion zählt.
  if (ev.email) out.em = await safeHash("hash(email)", () => ensureHashed(ev.email!, "email"));
  else out.em = ev.em ?? identity.em;
  // Namens-Hashes trägt nur die gespeicherte Identität bei — es gibt kein
  // Klartextfeld am Event, aus dem sie sonst entstehen könnten. Wer sie selbst
  // rechnet, setzt `fn`/`ln` direkt und gewinnt damit.
  out.fn = ev.fn ?? identity.fn;
  out.ln = ev.ln ?? identity.ln;
  if (ev.phone) {
    // Zwei Hashes: Meta verlangt die Nummer ohne, Google mit Pluszeichen.
    out.ph = await safeHash("hash(phone)", () => hashPhone(ev.phone!));
    out.ph_e164 = await safeHash("hash(phone)", () => hashPhoneE164(ev.phone!));
  } else {
    out.ph = ev.ph ?? identity.ph;
    out.ph_e164 = ev.ph_e164 ?? identity.ph_e164;
  }
  delete out.email;
  delete out.phone;

  // Klartext-Kontaktdaten. Zwei Bedingungen, beide müssen erfüllt sein:
  // ausdrückliche Einwilligung MIT Speicher-Erlaubnis, und das Event bringt
  // sie selbst mit oder ist das identify. Jeder Seitenaufruf trüge sonst eine
  // Kopie desselben Namens durchs Netz, ohne dass es der Auswertung nützt —
  // die Personenansicht nimmt den zuletzt gesehenen Wert.
  if (contactAllowed()) {
    const mail = ev.contact_email ?? (ev.type === "identify" ? contact.email : undefined);
    out.contact_email = mail && looksLikeEmail(mail) ? mail : undefined;
    const name = ev.contact_name ?? (ev.type === "identify" ? contact.name : undefined);
    out.contact_name = name ? name.slice(0, 120) : undefined;
    // Vor- und Nachname getrennt, unter genau denselben Bedingungen und mit
    // derselben Grenze wie der ganze Name. Der Collector weist ein Event mit
    // 400 ab, das darüber liegt — lieber ein gekürzter Name als kein Kauf.
    const vorname = ev.contact_first_name ?? (ev.type === "identify" ? contact.firstName : undefined);
    out.contact_first_name = vorname ? vorname.slice(0, 120) : undefined;
    const nachname = ev.contact_last_name ?? (ev.type === "identify" ? contact.lastName : undefined);
    out.contact_last_name = nachname ? nachname.slice(0, 120) : undefined;
  } else {
    // Auch, was das Event selbst mitbrachte: Ohne Entscheidung geht nichts
    // Lesbares raus, und zwar unabhängig davon, wer es gesetzt hat.
    delete out.contact_email;
    delete out.contact_name;
    delete out.contact_first_name;
    delete out.contact_last_name;
  }

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
    // `.catch` ist Pflicht, nicht Höflichkeit: `fetch` lehnt asynchron ab
    // (Ad-Blocker, Offline, CORS) — das synchrone `catch` unten sähe das nie,
    // und die Ablehnung landete als Unhandled Rejection im Fehler-Monitoring
    // der einbindenden Seite. Debug-Log statt Warnung: Ein blockierter
    // Request ist der Normalfall, keine Störung.
    void fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true }).catch(
      (e: unknown) => log("Transportfehler", e),
    );
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
  try {
    await dispatch(ev);
  } catch (e) {
    // Letzte Klammer: `track()` ruft `send()` ohne await auf, eine Ablehnung
    // hier wäre eine Unhandled Rejection — im Fehler-Monitoring des Shops
    // ununterscheidbar von dessen eigenen Fehlern.
    warnOnce("send", e);
  }
}

async function dispatch(ev: TrackEvent): Promise<void> {
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
  guard(
    "track",
    () => {
      // Werkzeuge ohne eigenes Ereignis: Vielleicht hat der Besucher
      // inzwischen entschieden, dann läuft die Warteschlange jetzt an.
      if (queue.length > 0 || schweigt()) applyCmp();
      if (schweigt()) {
        if (queue.length < (options?.queueLimit ?? 50)) queue.push(ev);
        log("gepuffert", ev.type);
        return;
      }
      if (ev.type === "purchase") {
        syncEnrichment({ purchaseValue: ev.value });
        if (options?.clarityUpgradeOnPurchase && options?.clarity !== false) {
          guard("clarity-upgrade", () => upgradeClarity("trackdolphin_purchase"), undefined);
        }
      }
      void send(ev);
    },
    undefined,
  );
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
