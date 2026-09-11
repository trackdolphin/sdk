/**
 * Passive Erkennung des Consent-Werkzeugs im Browser.
 *
 * Warum es das gibt: Auf primetime-fitness.de trug jedes Ereignis
 * `ad_storage: granted`, auch Seitenaufrufe aus der Google-App. Das war kein
 * gemessener Wille, sondern die Voreinstellung eines
 * `gtag('consent','default',…)`, und für den Server sah beides gleich aus.
 * Der Kunde glaubte, DSGVO-konform zu messen, und niemand konnte ihm sagen,
 * dass sein Banner das Signal nie setzt.
 *
 * Deshalb meldet das SDK ab jetzt ZWEI Dinge neben dem Zustand: welches
 * Werkzeug es sieht (`cmp`) und woher der Zustand stammt (`source`). Erst
 * damit kann die Gesundheitsprüfung sagen: „Cookiebot ist da, aber es kam
 * nie eine Ablehnung an, und kein Zustand stammt aus dem Werkzeug."
 *
 * Passiv heisst: Wir laden nichts, wir rufen keine Oberfläche auf, wir lesen
 * nur, was ohnehin im Fenster liegt. Und wir raten nicht: Wo ein Werkzeug den
 * Zustand nicht sauber herausgibt, bleibt er leer und nur der Name steht da.
 * Ein erfundenes „granted" wäre genau der Fehler, den diese Datei beheben
 * soll.
 */

/** Die vier Signale nach Consent Mode v2, ohne Herkunftsschlüssel. */
export interface ConsentSignals {
  ad_storage?: "granted" | "denied";
  analytics_storage?: "granted" | "denied";
  ad_user_data?: "granted" | "denied";
  ad_personalization?: "granted" | "denied";
}

/**
 * Die Namen, die das SDK meldet. Klein und ohne Leerzeichen, weil sie in
 * ClickHouse gruppiert und in der Oberfläche als Schlüssel verwendet werden.
 * `tcf` steht für ein Werkzeug, das nur über die IAB-Schnittstelle sichtbar
 * ist (consentmanager, Sourcepoint, Didomi …), `google-consent-mode` für den
 * Fall, dass nur Consent-Mode-Spuren im dataLayer liegen und kein Werkzeug
 * erkennbar ist.
 *
 * Die letzten drei meldet nicht das SDK, sondern die Shop-Plugins, deren
 * Snippets dieselbe Erkennung als Inline-Skript tragen: `wp-consent-api`
 * (WooCommerce, Browser und Kauf-Schnappschuss), `jtl` (Consent Manager von
 * JTL-Shop) und `shopware` (Cookie-Manager von Shopware). Sie stehen hier,
 * weil diese Liste der eine Ort ist, an dem die Namen geprüft werden
 * (event-typen.test.ts) — ein Name, den der Collector nicht kennt, fiele
 * sonst erst in der Oberfläche auf.
 */
export const CMP_NAMES = [
  // Trackdolphins eigener Banner (packages/consent-banner). Steht zuerst,
  // weil er die einzige Quelle ist, deren Modell wir selbst kennen: Er
  // liefert die Entscheidung als Zwecke, und wir übersetzen sie hier in die
  // vier Signale, ohne einen dataLayer-Umweg.
  "trackdolphin",
  "cookiebot",
  "usercentrics",
  "borlabs",
  "complianz",
  "real-cookie-banner",
  "consentmanager",
  // Seit 0.6.1 (Chris, 11.9.2026: „ein gründlicher Scan nach vorhandenen
  // CMPs"). Jeder Name hier hat einen belegten Anhaltspunkt im Fenster —
  // siehe die Funktionen weiter unten, dort steht die Quelle daneben.
  "onetrust",
  "cookieyes",
  "iubenda",
  "termly",
  "cookie-notice",
  "shopify",
  // Seit 0.5.1: Klaro (klaro.org), auch als gehostete KIProtect-Fassung.
  // Anlass war primetime-fitness.de, das Klaro über api.kiprotect.com lädt
  // und im Dashboard trotzdem „kein Werkzeug" zeigte.
  "klaro",
  "tcf",
  "google-consent-mode",
  "wp-consent-api",
  "jtl",
  "shopware",
] as const;
export type CmpName = (typeof CMP_NAMES)[number];

export interface CmpReading {
  /** Erkanntes Werkzeug, leer wenn keins. */
  cmp: CmpName | "";
  /** Der Zustand, falls das Werkzeug ihn liefert; sonst null. */
  state: ConsentSignals | null;
  /**
   * Ob der Zustand eine ENTSCHEIDUNG ist. Ein Consent-Mode-`default` ist
   * keine; er wird als `source: default` gemeldet, mit Signalen, aber ohne
   * die Behauptung, jemand hätte zugestimmt.
   */
  decided: boolean;
}

/** Die Fensterereignisse, nach denen sich der Zustand geändert haben kann. */
export const CMP_CHANGE_EVENTS = [
  // Trackdolphins eigener Banner
  "trackdolphin_consent",
  // Cookiebot
  "CookiebotOnConsentReady",
  "CookiebotOnAccept",
  "CookiebotOnDecline",
  // Usercentrics
  "UC_UI_INITIALIZED",
  "UC_UI_VIEW_CHANGED",
  // Borlabs Cookie 3 / 2
  "borlabs-cookie-consent-saved",
  "borlabsCookieConsentSaved",
  // WP Consent API (Real Cookie Banner, Complianz und andere bespielen sie)
  "wp_listen_for_consent_change",
  // Complianz
  "cmplz_status_change",
  "cmplz_fire_categories",
  // Shopify Customer Privacy API
  "visitorConsentCollected",
  // CookieYes: cookieyes.com/documentation/retrieving-consent-data-using-api-getckyconsent
  "cookieyes_banner_loaded",
  "cookieyes_consent_update",
  // OneTrust: developer.onetrust.com/onetrust/docs/javascript-events-guide
  "OneTrustGroupsUpdated",
  // Klaro feuert KEIN Fensterereignis; es meldet Änderungen nur an
  // Beobachter des ConsentManagers. Siehe `listenKlaro` weiter unten.
] as const;

type Win = Record<string, unknown>;

/** Das Fenster, ohne Absturz auf dem Server und ohne `any` in der Fläche. */
function win(): Win {
  return (typeof window !== "undefined" ? window : globalThis) as unknown as Win;
}

const yes = (b: unknown): "granted" | "denied" => (b ? "granted" : "denied");

/**
 * Cookiebot: `Cookiebot.consent` trägt die Kategorien, `hasResponse` sagt,
 * ob der Besucher überhaupt geantwortet hat. Ohne Antwort stehen alle
 * Kategorien auf false, und das wäre als „denied" eine Behauptung, die der
 * Besucher nie gemacht hat; deshalb dann nur der Name.
 */
function cookiebot(w: Win): CmpReading | null {
  const cb = w.Cookiebot as { consent?: Record<string, unknown>; hasResponse?: boolean; consented?: boolean; declined?: boolean } | undefined;
  if (!cb || typeof cb !== "object") return null;
  const decided = cb.hasResponse === true || cb.consented === true || cb.declined === true;
  if (!decided || !cb.consent) return { cmp: "cookiebot", state: null, decided: false };
  const c = cb.consent;
  return {
    cmp: "cookiebot",
    decided: true,
    state: {
      ad_storage: yes(c.marketing),
      ad_user_data: yes(c.marketing),
      ad_personalization: yes(c.marketing),
      analytics_storage: yes(c.statistics),
    },
  };
}

/**
 * Usercentrics v2: `UC_UI.getServicesBaseInfo()` listet Dienste mit Kategorie
 * und Status, `isConsentRequired()` sagt, ob noch eine Entscheidung aussteht.
 * Kategorie-Slugs sind frei konfigurierbar; wir erkennen die üblichen an
 * ihrem Wortstamm. Passt keiner, bleibt das Signal weg statt geraten.
 */
function usercentrics(w: Win): CmpReading | null {
  const uc = w.UC_UI as { getServicesBaseInfo?: () => unknown; isConsentRequired?: () => boolean } | undefined;
  if (!uc || typeof uc !== "object") return null;
  const presence: CmpReading = { cmp: "usercentrics", state: null, decided: false };
  try {
    if (typeof uc.isConsentRequired === "function" && uc.isConsentRequired()) return presence;
    if (typeof uc.getServicesBaseInfo !== "function") return presence;
    const dienste = uc.getServicesBaseInfo();
    if (!Array.isArray(dienste)) return presence;
    let marketing: boolean | undefined;
    let analytics: boolean | undefined;
    for (const d of dienste as { categorySlug?: string; consent?: { status?: boolean } }[]) {
      const slug = String(d.categorySlug ?? "").toLowerCase();
      const status = d.consent?.status === true;
      if (/marketing|advert|werb/.test(slug)) marketing = (marketing ?? false) || status;
      else if (/analytic|statisti|measure|mess/.test(slug)) analytics = (analytics ?? false) || status;
    }
    if (marketing === undefined && analytics === undefined) return presence;
    const state: ConsentSignals = {};
    if (marketing !== undefined) {
      state.ad_storage = yes(marketing);
      state.ad_user_data = yes(marketing);
      state.ad_personalization = yes(marketing);
    }
    if (analytics !== undefined) state.analytics_storage = yes(analytics);
    return { cmp: "usercentrics", state, decided: true };
  } catch {
    return presence;
  }
}

/**
 * Shopify Customer Privacy API: `currentVisitorConsent()` liefert je Zweck
 * "yes", "no" oder "" (noch nicht gefragt). Leer heisst offen, nicht nein.
 */
function shopify(w: Win): CmpReading | null {
  const sh = w.Shopify as { customerPrivacy?: { currentVisitorConsent?: () => Record<string, unknown> } } | undefined;
  const cp = sh?.customerPrivacy;
  if (!cp || typeof cp !== "object") return null;
  const presence: CmpReading = { cmp: "shopify", state: null, decided: false };
  try {
    if (typeof cp.currentVisitorConsent !== "function") return presence;
    const c = cp.currentVisitorConsent() ?? {};
    const marketing = c.marketing === "yes" ? true : c.marketing === "no" ? false : undefined;
    const analytics = c.analytics === "yes" ? true : c.analytics === "no" ? false : undefined;
    if (marketing === undefined && analytics === undefined) return presence;
    const state: ConsentSignals = {};
    if (marketing !== undefined) {
      state.ad_storage = yes(marketing);
      state.ad_user_data = yes(marketing);
      state.ad_personalization = yes(marketing);
    }
    if (analytics !== undefined) state.analytics_storage = yes(analytics);
    return { cmp: "shopify", state, decided: true };
  } catch {
    return presence;
  }
}

/** Was `__tcfapi('getTCData')` bzw. der Listener liefert, soweit wir es brauchen. */
export interface TcData {
  gdprApplies?: boolean;
  eventStatus?: string;
  purpose?: { consents?: Record<string, boolean> };
}

/**
 * IAB TCF 2.x, in Googles Zuordnung: Zweck 1 → ad_storage, Zwecke 1+7 →
 * ad_user_data, Zwecke 3+4 → ad_personalization, Zweck 8 → analytics_storage.
 * Gilt die DSGVO laut CMP nicht (`gdprApplies: false`), ist alles erteilt,
 * und zwar entschieden: Das ist die Aussage des Werkzeugs, nicht unsere.
 */
export function tcfState(tc: TcData | null): { state: ConsentSignals; decided: boolean } | null {
  if (!tc) return null;
  if (tc.gdprApplies === false) {
    return {
      decided: true,
      state: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" },
    };
  }
  const decided = tc.eventStatus === "tcloaded" || tc.eventStatus === "useractioncomplete";
  if (!decided) return null;
  const p = tc.purpose?.consents ?? {};
  const has = (n: number) => p[String(n)] === true;
  return {
    decided: true,
    state: {
      ad_storage: yes(has(1)),
      ad_user_data: yes(has(1) && has(7)),
      ad_personalization: yes(has(3) && has(4)),
      analytics_storage: yes(has(8)),
    },
  };
}

/**
 * Google Consent Mode aus dem dataLayer: `gtag('consent','default'|'update', …)`
 * landet dort als arguments-Objekt `['consent', 'update', {…}]`.
 *
 * Der Unterschied zwischen `default` und `update` ist der ganze Punkt dieser
 * Datei. Die Plugin-Snippets lasen bisher beides gleich, und genau so wurde
 * aus primetimes Voreinstellung eine Zustimmung. Ein `update` ist eine
 * Entscheidung, ein `default` ist keine.
 */
function consentModeFromDataLayer(w: Win): { state: ConsentSignals; decided: boolean } | null {
  const dl = w.dataLayer;
  if (!Array.isArray(dl)) return null;
  let def: ConsentSignals | null = null;
  let upd: ConsentSignals | null = null;
  for (const e of dl as unknown[]) {
    if (!e || typeof e !== "object") continue;
    const a = e as { [k: number]: unknown; length?: number };
    if (a[0] !== "consent" || (a[1] !== "default" && a[1] !== "update")) continue;
    const params = a[2];
    if (!params || typeof params !== "object") continue;
    const s = signalsOf(params as Record<string, unknown>);
    if (!s) continue;
    if (a[1] === "update") upd = { ...(upd ?? {}), ...s };
    else def = { ...(def ?? {}), ...s };
  }
  if (upd) return { state: { ...(def ?? {}), ...upd }, decided: true };
  if (def) return { state: def, decided: false };
  return null;
}

/**
 * Googles eigener Zustandsspeicher (`google_tag_data.ics.entries`), den gtag.js
 * anlegt. Nicht dokumentiert, deshalb nur als Bestätigung hinter dem
 * dataLayer und mit Fanggriff: Ändert Google das Format, fehlt hier nur ein
 * Rückfall, nicht das Tracking.
 */
function consentModeFromIcs(w: Win): { state: ConsentSignals; decided: boolean } | null {
  try {
    const entries = (w.google_tag_data as { ics?: { entries?: Record<string, { default?: boolean; update?: boolean }> } } | undefined)?.ics?.entries;
    if (!entries || typeof entries !== "object") return null;
    const state: ConsentSignals = {};
    let decided = false;
    let any = false;
    for (const k of SIGNALS) {
      const e = entries[k];
      if (!e) continue;
      if (typeof e.update === "boolean") {
        state[k] = yes(e.update);
        decided = true;
        any = true;
      } else if (typeof e.default === "boolean") {
        state[k] = yes(e.default);
        any = true;
      }
    }
    return any ? { state, decided } : null;
  } catch {
    return null;
  }
}

const SIGNALS = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"] as const;

/** Nur die vier Signale, nur mit gültigen Werten; alles andere fällt weg. */
function signalsOf(o: Record<string, unknown>): ConsentSignals | null {
  const out: ConsentSignals = {};
  let any = false;
  for (const k of SIGNALS) {
    const v = o[k];
    if (v === "granted" || v === "denied") {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Trackdolphins eigener Banner: `window.TrackdolphinConsent.get()` liefert
 * die Entscheidung mit Zwecken (essential, functional, statistics,
 * marketing). Ohne Entscheidung ist der Banner da, aber niemand hat
 * geantwortet: Name ja, Zustand nein.
 */
function trackdolphinBanner(w: Win): CmpReading | null {
  const api = (w as unknown as { TrackdolphinConsent?: { get?: () => { purposes?: Record<string, boolean> } | null } }).TrackdolphinConsent;
  if (!api || typeof api !== "object") return null;
  const decision = typeof api.get === "function" ? api.get() : null;
  const p = decision?.purposes;
  if (!p || typeof p !== "object") return { cmp: "trackdolphin", state: null, decided: false };
  const marketing = p.marketing === true ? "granted" : "denied";
  return {
    cmp: "trackdolphin",
    decided: true,
    state: {
      ad_storage: marketing,
      ad_user_data: marketing,
      ad_personalization: marketing,
      analytics_storage: p.statistics === true ? "granted" : "denied",
    },
  };
}

/**
 * CookieYes: `getCkyConsent()` liefert die Kategorien.
 *
 * Quelle: cookieyes.com/documentation/retrieving-consent-data-using-api-getckyconsent —
 * `categories` mit `necessary`, `functional`, `analytics`, `performance`,
 * `advertisement`. Der Rückgabewert trägt zusätzlich, ob der Besucher schon
 * geantwortet hat; fehlt dieses Feld (ältere Fassung), gilt hier NICHT
 * „entschieden": Ohne Antwort stehen alle Kategorien auf false, und das als
 * „denied" zu melden wäre dieselbe Erfindung, die schon bei Cookiebot
 * ausgeschlossen ist.
 */
function cookieyes(w: Win): CmpReading | null {
  const lesen = w.getCkyConsent;
  if (typeof lesen !== "function") return null;
  const presence: CmpReading = { cmp: "cookieyes", state: null, decided: false };
  try {
    const c = (lesen as () => { categories?: Record<string, unknown>; isUserActionCompleted?: boolean })();
    if (c?.isUserActionCompleted !== true || !c.categories || typeof c.categories !== "object") return presence;
    const k = c.categories;
    const marketing = yes(k.advertisement);
    return {
      cmp: "cookieyes",
      decided: true,
      state: {
        ad_storage: marketing,
        ad_user_data: marketing,
        ad_personalization: marketing,
        analytics_storage: yes(k.analytics),
      },
    };
  } catch {
    return presence;
  }
}

/**
 * Klaro: welche Zwecke für welches Signal zählen.
 *
 * Quelle der Zweck-Namen: Klaros eigene Übersetzungen
 * (github.com/klaro-org/klaro-js, src/translations/en.yml → `purposes`:
 * `advertising`, `functional`, `marketing`, `performance`) und die
 * Beispielkonfiguration (dist/config.js: `analytics`, `advertising`,
 * `security`, `livechat`, `styling`). Die gehostete KIProtect-Fassung auf
 * primetime-fitness.de nutzt `functional`, `performance` (Google Analytics,
 * Sentry, PostHog) und `marketing` (Meta).
 *
 * Zwecke sind frei benennbar. Was hier nicht steht (`functional`,
 * `security`, `livechat`, `styling`, alles Eigene), hat keine Wirkung auf
 * die Signale: Aus einem unbekannten Zweck wird weder „granted" noch
 * „denied".
 */
const KLARO_ZWECKE_MESSUNG = new Set(["analytics", "statistics", "statistik", "performance"]);
const KLARO_ZWECKE_WERBUNG = new Set(["marketing", "advertising", "ads", "targeting", "werbung"]);

/**
 * Dienste, deren NAME eindeutig sagt, wofür sie da sind, auch wenn der
 * Betreiber den Zweck frei benannt hat. Verglichen wird ohne Gross/klein und
 * ohne Trennzeichen (`google-analytics` = `googleAnalytics`), und nur
 * vollständig: Ein Name wie „facebook" oder „linkedin" steht bewusst NICHT
 * da, weil er genauso gut ein eingebetteter Beitrag oder ein Teilen-Knopf
 * sein kann.
 */
const KLARO_DIENSTE_MESSUNG = new Set(["googleanalytics", "googleanalytics4", "ga4", "universalanalytics", "gtag"]);
const KLARO_DIENSTE_WERBUNG = new Set([
  "googleads", "googleadwords", "adwords", "adsense", "googleadsense", "doubleclick",
  "meta", "metapixel", "facebookpixel",
  "tiktokpixel", "pinteresttag", "linkedininsight", "linkedininsighttag",
  "microsoftads", "microsoftadvertising", "bingads",
  "snappixel", "redditpixel", "criteo", "taboola", "outbrain",
]);

const klaroSchluessel = (s: unknown): string => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

interface KlaroService {
  name?: unknown;
  purposes?: unknown;
  required?: boolean;
  contextualConsentOnly?: boolean;
}
interface KlaroManager {
  confirmed?: boolean;
  consents?: Record<string, unknown>;
  savedConsents?: Record<string, unknown>;
  config?: { services?: KlaroService[]; apps?: KlaroService[]; required?: boolean };
  watch?: (watcher: { update: (manager: unknown, eventType: string, data: unknown) => void }) => void;
}

function klaroManager(w: Win): KlaroManager | null {
  const k = w.klaro as { getManager?: () => unknown } | undefined;
  if (!k || typeof k !== "object" || typeof k.getManager !== "function") return null;
  const m = k.getManager();
  return m && typeof m === "object" ? (m as KlaroManager) : null;
}

/**
 * Klaro (klaro.org, auch gehostet über api.kiprotect.com).
 *
 * Quelle: github.com/klaro-org/klaro-js (klaro.org/docs antwortet
 * automatisierten Abrufen mit 403), src/lib.js und src/consent-manager.js,
 * und am lebenden Objekt nachgesehen (primetime-fitness.de, Klaro 0.7.22,
 * 11.9.2026):
 *
 * - `klaro.getManager()` liefert den ConsentManager.
 * - `confirmed` wird erst true, wenn der Besucher gespeichert hat
 *   (`saveConsents`) oder eine vollständige gespeicherte Entscheidung geladen
 *   wurde (`_checkConsents`). Vorher stehen in `consents` nur die
 *   Voreinstellungen der Dienste; die als „denied" zu melden wäre dieselbe
 *   Erfindung wie bei Cookiebot ohne Antwort. Dann: nur der Name.
 * - `savedConsents` ist der gespeicherte Stand, `consents` ändert sich schon
 *   beim Umschalten im Dialog, bevor jemand speichert. Deshalb zählt
 *   `savedConsents`, `consents` nur als Rückfall für Fassungen ohne das Feld.
 * - `config.services[]` trägt `name`, `purposes[]` und `required`; vor 0.7
 *   hiess die Liste `apps`.
 *
 * Abgeleitet wird je Signalgruppe aus den Diensten, die per Zweck oder per
 * Name dazugehören. `required`-Dienste zählen NICHT: Ihre Zustimmung setzt
 * der Betreiber, nicht der Besucher (auf primetime-fitness.de ist PostHog so
 * eingestellt, mit Zweck `performance`). Dienste nur mit kontextueller
 * Zustimmung zählen ebenfalls nicht, weil „Alle annehmen" sie nicht
 * einschliesst. Erteilt ist eine Gruppe nur, wenn ALLE ihre Dienste
 * zugestimmt sind; ein einziger abgelehnter macht sie „denied". Das ist
 * bewusst die vorsichtige Lesart: Wer Google Analytics annimmt und Sentry
 * im selben Zweck ablehnt, bekommt kein „granted" für die Messung.
 */
function klaro(w: Win): CmpReading | null {
  if (!w.klaro || typeof w.klaro !== "object") return null;
  const presence: CmpReading = { cmp: "klaro", state: null, decided: false };
  try {
    const m = klaroManager(w);
    if (!m || m.confirmed !== true) return presence;
    const cfg = m.config ?? {};
    const dienste = Array.isArray(cfg.services) ? cfg.services : Array.isArray(cfg.apps) ? cfg.apps : [];
    const stand = m.savedConsents && typeof m.savedConsents === "object" ? m.savedConsents : (m.consents ?? {});
    let werbung: boolean | undefined;
    let messung: boolean | undefined;
    for (const d of dienste) {
      if (!d || typeof d.name !== "string") continue;
      if (d.required ?? cfg.required ?? false) continue;
      if (d.contextualConsentOnly === true) continue;
      const name = klaroSchluessel(d.name);
      const zwecke = Array.isArray(d.purposes) ? d.purposes.map(klaroSchluessel) : [];
      const ja = stand[d.name] === true;
      if (KLARO_DIENSTE_WERBUNG.has(name) || zwecke.some((z) => KLARO_ZWECKE_WERBUNG.has(z))) werbung = (werbung ?? true) && ja;
      if (KLARO_DIENSTE_MESSUNG.has(name) || zwecke.some((z) => KLARO_ZWECKE_MESSUNG.has(z))) messung = (messung ?? true) && ja;
    }
    if (werbung === undefined && messung === undefined) return presence;
    const state: ConsentSignals = {};
    if (werbung !== undefined) {
      state.ad_storage = yes(werbung);
      state.ad_user_data = yes(werbung);
      state.ad_personalization = yes(werbung);
    }
    if (messung !== undefined) state.analytics_storage = yes(messung);
    return { cmp: "klaro", state, decided: true };
  } catch {
    return presence;
  }
}

/**
 * Nur der Name — Werkzeuge, deren Zustand wir nicht sauber lesen können.
 *
 * Jeder Eintrag hat eine Quelle. Was hier NICHT steht, steht mit Absicht
 * nicht da: Bei OneTrust hängen die Kategorien an frei vergebenen
 * Gruppen-Kennungen (`C0002`, `C0004` sind nur die Voreinstellung), bei
 * iubenda an nummerierten Zwecken, bei Termly an einem Objekt ohne
 * dokumentierte Form. Aus einem geratenen Schlüssel ein „granted" zu machen
 * wäre genau der Fehler von primetime-fitness.de. Der Name allein genügt für
 * den Zweck: Er unterscheidet „kein Consent-Werkzeug" von „eines da, aber es
 * meldet uns nichts".
 */
function presenceOnly(w: Win): CmpName | "" {
  if (w.BorlabsCookie) return "borlabs";
  if (w.complianz || typeof w.cmplz_has_consent === "function" || Object.keys(w).some((k) => k.startsWith("cmplz_"))) return "complianz";
  if (w.consentApi && typeof w.consentApi === "object") return "real-cookie-banner";
  // developer.onetrust.com/onetrust/docs/javascript-api: `OneTrust` ist das
  // API-Objekt (u. a. `IsAlertBoxClosed()`), `OnetrustActiveGroups` die
  // Liste der freigegebenen Gruppen. `Optanon`/`OptanonActiveGroups` ist das
  // ältere Namensschema derselben Software.
  if (w.OneTrust || w.OnetrustActiveGroups !== undefined || w.Optanon || w.OptanonActiveGroups !== undefined) return "onetrust";
  // iubenda.com/en/help/6473-consent-solution-js-documentation: `_iub` ist
  // das Konfigurationsobjekt jeder iubenda-Einbindung.
  if (w._iub && typeof w._iub === "object") return "iubenda";
  // support.termly.io: `Termly.getConsentState()` — das Objekt gibt es erst,
  // wenn das Einbettungsskript fertig geladen hat.
  if (w.Termly && typeof w.Termly === "object") return "termly";
  // wordpress.org/plugins/cookie-notice (hu-manity.co): `huOptions` ist die
  // Konfiguration des ausgelieferten Banners.
  if (w.huOptions && typeof w.huOptions === "object") return "cookie-notice";
  // Klaro, bevor klaro.js fertig ist: github.com/klaro-org/klaro-js,
  // src/lib.js `setup()` liest die Konfiguration aus `window.klaroConfig`
  // (Name über `data-klaro-config` änderbar) bzw. bei der gehosteten Fassung
  // aus `window.klaroApiConfigs`. Ist `window.klaro` schon da, erkennt es
  // `klaro()` weiter oben.
  if ((w.klaroConfig && typeof w.klaroConfig === "object") || Array.isArray(w.klaroApiConfigs)) return "klaro";
  if (typeof w.__cmp === "function") return "consentmanager";
  if (typeof w.__tcfapi === "function") return "tcf";
  return "";
}

/**
 * Ein Blick ins Fenster. Reihenfolge: Werkzeuge, die den Zustand herausgeben,
 * dann solche, die wir nur sehen, dann die Consent-Mode-Spuren. Der ERSTE
 * entschiedene Zustand gewinnt; der Name kommt vom ersten erkannten Werkzeug,
 * damit „usercentrics" nicht zu „google-consent-mode" wird, bloss weil
 * Usercentrics den Zustand über Consent Mode weitergibt.
 */
export function readCmp(tc: TcData | null = null): CmpReading {
  const w = win();
  const versuche: (CmpReading | null)[] = [];
  try {
    versuche.push(trackdolphinBanner(w), cookiebot(w), usercentrics(w), cookieyes(w), shopify(w), klaro(w));
  } catch {
    /* ein kaputtes Werkzeug darf die Erkennung der anderen nicht kosten */
  }
  const erkannt = versuche.filter((r): r is CmpReading => r !== null);
  const entschieden = erkannt.find((r) => r.decided && r.state);
  if (entschieden) return entschieden;

  const name: CmpName | "" = erkannt[0]?.cmp || presenceOnly(w);

  const tcf = tcfState(tc);
  if (tcf) return { cmp: name || "tcf", state: tcf.state, decided: true };

  const cm = consentModeFromDataLayer(w) ?? consentModeFromIcs(w);
  if (cm) return { cmp: name || "google-consent-mode", state: cm.state, decided: cm.decided };

  return { cmp: name, state: null, decided: false };
}

/**
 * Beim TCF kommt der Zustand nur per Rückruf. Der Listener hält ihn aktuell;
 * `onChange` läuft bei jeder Änderung, damit der Aufrufer die Warteschlange
 * freigeben kann. Ohne `__tcfapi` passiert nichts.
 */
export function listenTcf(onChange: (tc: TcData) => void): void {
  const api = win().__tcfapi;
  if (typeof api !== "function") return;
  try {
    (api as (cmd: string, v: number, cb: (tc: TcData, ok: boolean) => void) => void)(
      "addEventListener",
      2,
      (tc, ok) => {
        if (ok && tc) onChange(tc);
      },
    );
  } catch {
    /* ein CMP, das beim Anmelden wirft, liefert eben keinen Zustand */
  }
}

/**
 * Klaro meldet Änderungen nicht als Fensterereignis, sondern an Beobachter
 * des ConsentManagers: `manager.watch({ update(manager, eventType, data) })`
 * (src/consent-manager.js; `eventType` ist `consents`, `saveConsents` oder
 * `applyConsents`). Wir hören auf alle drei, denn `readCmp` liest ohnehin den
 * gespeicherten Stand und `confirmed`, ein Umschalten im Dialog ändert das
 * Ergebnis also nicht.
 *
 * Gibt zurück, ob die Anmeldung geklappt hat. Klaro lädt oft NACH dem SDK
 * (auf primetime-fitness.de per `defer` am Ende des Body); der Aufrufer
 * fragt dann beim nächsten Blick ins Fenster noch einmal.
 */
export function listenKlaro(onChange: () => void): boolean {
  try {
    const m = klaroManager(win());
    if (!m || typeof m.watch !== "function") return false;
    m.watch({ update: () => onChange() });
    return true;
  } catch {
    return false;
  }
}
