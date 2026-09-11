import { test } from "node:test";
import assert from "node:assert/strict";
import { CMP_NAMES, listenKlaro, readCmp, tcfState, type TcData } from "./cmp.ts";

/**
 * Die Erkennung läuft gegen Attrappen der globalen Objekte. Geprüft wird
 * nicht, ob Cookiebot funktioniert, sondern ob WIR aus dem, was Cookiebot
 * hinterlässt, das Richtige schliessen: Name ja, Zustand nur bei einer
 * Entscheidung, und ein Consent-Mode-`default` ist keine.
 */

const GLOBALS = ["Cookiebot", "UC_UI", "Shopify", "BorlabsCookie", "complianz", "cmplz_has_consent", "consentApi", "__cmp", "__tcfapi", "dataLayer", "google_tag_data",
  "getCkyConsent", "OneTrust", "OnetrustActiveGroups", "Optanon", "OptanonActiveGroups", "_iub", "Termly", "huOptions",
  "klaro", "klaroConfig", "klaroApiConfigs"];

function leer(): void {
  for (const k of GLOBALS) delete (globalThis as Record<string, unknown>)[k];
}

function setze(k: string, v: unknown): void {
  (globalThis as Record<string, unknown>)[k] = v;
}

test("ohne Werkzeug: kein Name, kein Zustand, nichts entschieden", () => {
  leer();
  assert.deepEqual(readCmp(), { cmp: "", state: null, decided: false });
});

test("Cookiebot ohne Antwort: nur der Name, kein erfundenes denied", () => {
  leer();
  setze("Cookiebot", { hasResponse: false, consent: { marketing: false, statistics: false } });
  assert.deepEqual(readCmp(), { cmp: "cookiebot", state: null, decided: false });
});

test("Cookiebot mit Antwort: Kategorien werden zu den vier Signalen", () => {
  leer();
  setze("Cookiebot", { hasResponse: true, consent: { marketing: false, statistics: true } });
  const r = readCmp();
  assert.equal(r.cmp, "cookiebot");
  assert.equal(r.decided, true);
  assert.deepEqual(r.state, {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
  });
});

test("Usercentrics: offene Entscheidung heisst nur Name; sonst Kategorien nach Wortstamm", () => {
  leer();
  setze("UC_UI", { isConsentRequired: () => true, getServicesBaseInfo: () => [] });
  assert.deepEqual(readCmp(), { cmp: "usercentrics", state: null, decided: false });

  setze("UC_UI", {
    isConsentRequired: () => false,
    getServicesBaseInfo: () => [
      { categorySlug: "marketing", consent: { status: true } },
      { categorySlug: "statistik", consent: { status: false } },
      { categorySlug: "essential", consent: { status: true } },
    ],
  });
  const r = readCmp();
  assert.equal(r.decided, true);
  assert.deepEqual(r.state, {
    ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "denied",
  });
});

test("Shopify Customer Privacy: leer ist offen, yes/no ist entschieden", () => {
  leer();
  setze("Shopify", { customerPrivacy: { currentVisitorConsent: () => ({ marketing: "", analytics: "" }) } });
  assert.deepEqual(readCmp(), { cmp: "shopify", state: null, decided: false });

  setze("Shopify", { customerPrivacy: { currentVisitorConsent: () => ({ marketing: "no", analytics: "yes" }) } });
  const r = readCmp();
  assert.equal(r.cmp, "shopify");
  assert.equal(r.decided, true);
  assert.equal(r.state?.ad_storage, "denied");
  assert.equal(r.state?.analytics_storage, "granted");
});

test("Consent Mode: default ist eine Voreinstellung, update eine Entscheidung", () => {
  // Der Primetime-Fall: gtag('consent','default',{…granted}) und sonst nichts.
  leer();
  setze("dataLayer", [
    ["consent", "default", { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }],
    { event: "gtm.js" },
  ]);
  let r = readCmp();
  assert.equal(r.cmp, "google-consent-mode");
  assert.equal(r.decided, false, "ein default ist keine Entscheidung");
  assert.equal(r.state?.ad_storage, "granted", "die Signale werden trotzdem gemeldet, mit Kennzeichnung");

  // Kommt ein update, gilt es — auch über die Voreinstellung hinweg.
  ((globalThis as Record<string, unknown>).dataLayer as unknown[]).push(["consent", "update", { ad_storage: "denied", ad_user_data: "denied" }]);
  r = readCmp();
  assert.equal(r.decided, true);
  assert.equal(r.state?.ad_storage, "denied");
  assert.equal(r.state?.analytics_storage, "granted", "nicht aktualisierte Signale behalten die Voreinstellung");
});

test("Consent Mode aus google_tag_data, wenn der dataLayer nichts hergibt", () => {
  leer();
  setze("google_tag_data", { ics: { entries: { ad_storage: { default: false, update: true }, analytics_storage: { default: false } } } });
  const r = readCmp();
  assert.equal(r.cmp, "google-consent-mode");
  assert.equal(r.decided, true);
  assert.deepEqual(r.state, { ad_storage: "granted", analytics_storage: "denied" });
});

test("Werkzeug erkannt, Zustand aus Consent Mode: der Name bleibt der des Werkzeugs", () => {
  // Borlabs gibt den Zustand nicht sauber heraus, reicht ihn aber als
  // Consent-Mode-update weiter. Dann heisst das Werkzeug trotzdem borlabs.
  leer();
  setze("BorlabsCookie", {});
  setze("dataLayer", [["consent", "update", { ad_storage: "denied", analytics_storage: "denied" }]]);
  const r = readCmp();
  assert.equal(r.cmp, "borlabs");
  assert.equal(r.decided, true);
  assert.equal(r.state?.ad_storage, "denied");
});

test("Nur Anwesenheit: Borlabs, Complianz, RCB, consentmanager, TCF, OneTrust, iubenda, Termly, Cookie Notice", () => {
  const faelle: [string, unknown, string][] = [
    ["BorlabsCookie", {}, "borlabs"],
    ["complianz", {}, "complianz"],
    ["cmplz_has_consent", () => true, "complianz"],
    ["consentApi", {}, "real-cookie-banner"],
    ["__cmp", () => undefined, "consentmanager"],
    ["__tcfapi", () => undefined, "tcf"],
    // Seit 0.6.1, jeweils am belegten Anhaltspunkt (Quellen in cmp.ts)
    ["OneTrust", {}, "onetrust"],
    ["OnetrustActiveGroups", ",C0001,C0002,", "onetrust"],
    ["Optanon", {}, "onetrust"],
    ["OptanonActiveGroups", ",C0001,", "onetrust"],
    ["_iub", { csConfiguration: { siteId: 1 } }, "iubenda"],
    ["Termly", {}, "termly"],
    ["huOptions", {}, "cookie-notice"],
  ];
  for (const [k, v, name] of faelle) {
    leer();
    setze(k, v);
    assert.deepEqual(readCmp(), { cmp: name, state: null, decided: false }, k);
  }
});

test("TCF: Zwecke nach Googles Zuordnung, und ohne DSGVO ist alles erteilt", () => {
  const offen: TcData = { gdprApplies: true, eventStatus: "cmpuishown", purpose: { consents: {} } };
  assert.equal(tcfState(offen), null, "Banner offen: noch keine Entscheidung");

  const entschieden: TcData = {
    gdprApplies: true, eventStatus: "useractioncomplete",
    purpose: { consents: { "1": true, "3": true, "4": false, "7": true, "8": false } },
  };
  assert.deepEqual(tcfState(entschieden), {
    decided: true,
    state: { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "denied", analytics_storage: "denied" },
  });

  const ausserhalb: TcData = { gdprApplies: false };
  assert.equal(tcfState(ausserhalb)?.state.ad_storage, "granted");

  // Über readCmp: ein TCF-Werkzeug mit Entscheidung liefert Zustand und Namen.
  leer();
  setze("__tcfapi", () => undefined);
  const r = readCmp(entschieden);
  assert.equal(r.cmp, "tcf");
  assert.equal(r.decided, true);
  assert.equal(r.state?.ad_storage, "granted");
});

test("Ein werfendes Werkzeug kostet nicht die Erkennung", () => {
  leer();
  setze("Shopify", { customerPrivacy: { currentVisitorConsent: () => { throw new Error("kaputt"); } } });
  assert.deepEqual(readCmp(), { cmp: "shopify", state: null, decided: false });
});

test("Die Namen sind kurz, klein und ohne Leerzeichen — sie werden Gruppierungsschlüssel", () => {
  for (const n of CMP_NAMES) assert.match(n, /^[a-z][a-z0-9-]{1,40}$/);
});

// ---------------------------------------------------------------------------
// Trackdolphins eigener Banner (packages/consent-banner)
// ---------------------------------------------------------------------------
test("Trackdolphin-Banner: Entscheidung mit Zwecken wird zu den vier Signalen, Vorrang vor allem anderen", () => {
  const w = globalThis as unknown as Record<string, unknown>;
  const vorher = w.TrackdolphinConsent;
  const dataLayerVorher = w.dataLayer;
  try {
    w.dataLayer = [["consent", "default", { ad_storage: "granted", analytics_storage: "granted" }]];
    w.TrackdolphinConsent = { get: () => ({ purposes: { essential: true, functional: false, statistics: true, marketing: false } }) };
    const r = readCmp();
    assert.equal(r.cmp, "trackdolphin");
    assert.equal(r.decided, true);
    assert.deepEqual(r.state, { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });

    // Banner da, aber noch keine Entscheidung: Name ja, kein Zustand, und die
    // Voreinstellung aus dem dataLayer bleibt eine Voreinstellung.
    w.TrackdolphinConsent = { get: () => null };
    const offen = readCmp();
    assert.equal(offen.cmp, "trackdolphin");
    assert.equal(offen.decided, false);
  } finally {
    w.TrackdolphinConsent = vorher;
    w.dataLayer = dataLayerVorher;
  }
});

test("CookieYes: ohne Antwort nur der Name, mit Antwort die Kategorien", () => {
  leer();
  // Ohne abgeschlossene Aktion stehen alle Kategorien auf false — das als
  // „denied" zu melden wäre eine Behauptung, die niemand gemacht hat.
  setze("getCkyConsent", () => ({ isUserActionCompleted: false, categories: { advertisement: false, analytics: false } }));
  assert.deepEqual(readCmp(), { cmp: "cookieyes", state: null, decided: false });

  setze("getCkyConsent", () => ({
    isUserActionCompleted: true,
    categories: { necessary: true, functional: true, analytics: true, performance: true, advertisement: false },
  }));
  const r = readCmp();
  assert.equal(r.cmp, "cookieyes");
  assert.equal(r.decided, true);
  assert.deepEqual(r.state, {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
  });
});

test("CookieYes, das wirft, liefert den Namen statt die Erkennung zu kosten", () => {
  leer();
  setze("getCkyConsent", () => { throw new Error("nicht bereit"); });
  assert.deepEqual(readCmp(), { cmp: "cookieyes", state: null, decided: false });
});

test("Ein nur anwesendes Werkzeug behält seinen Namen, auch wenn der Zustand aus Consent Mode kommt", () => {
  leer();
  // OneTrust gibt seine Gruppen nicht in einer Form heraus, die wir ohne
  // Konfiguration deuten könnten — der Zustand kommt aus dem Consent Mode,
  // der Name bleibt OneTrust. Ohne das hiesse das Werkzeug im Dashboard
  // „google-consent-mode", und der Händler suchte ein Werkzeug, das er hat.
  setze("OneTrust", {});
  setze("dataLayer", [{ 0: "consent", 1: "update", 2: { ad_storage: "granted" }, length: 3 }]);
  const r = readCmp();
  assert.equal(r.cmp, "onetrust");
  assert.equal(r.decided, true);
  assert.equal(r.state?.ad_storage, "granted");
});

// ---------------------------------------------------------------------------
// Klaro (klaro.org, gehostet auch über api.kiprotect.com)
// ---------------------------------------------------------------------------

type KlaroWatcher = { update: (manager: unknown, eventType: string, data: unknown) => void };

/**
 * Die Dienste so, wie sie am 11.9.2026 auf primetime-fitness.de im Fenster
 * standen (Klaro 0.7.22): Name, Zwecke und `required`, sonst nichts.
 */
function ptfDienste() {
  return [
    { name: "cloudflare", purposes: ["functional"], required: true, default: true },
    { name: "posthog", purposes: ["performance"], required: true, default: true },
    { name: "google-analytics", purposes: ["performance"], required: false, default: false },
    { name: "sentry", purposes: ["performance"], required: false, default: false },
    { name: "meta", purposes: ["marketing"], required: false, default: false },
  ];
}

function klaroAttrappe(teil: Record<string, unknown> = {}) {
  const watchers: KlaroWatcher[] = [];
  const voreinstellung = { cloudflare: true, posthog: true, "google-analytics": false, sentry: false, meta: false };
  const manager: Record<string, unknown> = {
    confirmed: false,
    consents: { ...voreinstellung },
    savedConsents: { ...voreinstellung },
    config: { services: ptfDienste() },
    watch: (w: KlaroWatcher) => watchers.push(w),
    ...teil,
  };
  setze("klaro", { getManager: () => manager, version: () => "0.7.22" });
  return { manager, watchers };
}

test("Klaro ohne Entscheidung: nur der Name, auch wenn required-Dienste auf true stehen", () => {
  leer();
  klaroAttrappe();
  assert.deepEqual(readCmp(), { cmp: "klaro", state: null, decided: false });
});

test("Klaro entschieden: Messung an, Werbung aus; required-Dienste zählen nicht", () => {
  leer();
  const gespeichert = { cloudflare: true, posthog: true, "google-analytics": true, sentry: true, meta: false };
  klaroAttrappe({ confirmed: true, consents: { ...gespeichert }, savedConsents: { ...gespeichert } });
  assert.deepEqual(readCmp(), {
    cmp: "klaro",
    decided: true,
    state: { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" },
  });

  // Alles abgelehnt: PostHog bleibt als required auf true — und macht die
  // Messung trotzdem NICHT zu granted, denn zugestimmt hat der Betreiber.
  leer();
  const abgelehnt = { cloudflare: true, posthog: true, "google-analytics": false, sentry: false, meta: false };
  klaroAttrappe({ confirmed: true, consents: { ...abgelehnt }, savedConsents: { ...abgelehnt } });
  const r = readCmp();
  assert.equal(r.decided, true);
  assert.equal(r.state?.analytics_storage, "denied");
  assert.equal(r.state?.ad_storage, "denied");
});

test("Klaro: ein abgelehnter Dienst im selben Zweck macht die Gruppe denied", () => {
  leer();
  const gemischt = { cloudflare: true, posthog: true, "google-analytics": true, sentry: false, meta: true };
  klaroAttrappe({ confirmed: true, consents: { ...gemischt }, savedConsents: { ...gemischt } });
  const r = readCmp();
  assert.equal(r.state?.analytics_storage, "denied", "Sentry abgelehnt: kein granted für die Messung");
  assert.equal(r.state?.ad_storage, "granted");
});

test("Klaro: der gespeicherte Stand zählt, nicht das Umschalten im offenen Dialog", () => {
  leer();
  klaroAttrappe({
    confirmed: true,
    savedConsents: { cloudflare: true, posthog: true, "google-analytics": false, sentry: false, meta: false },
    // Der Besucher hat im Dialog umgeschaltet, aber noch nicht gespeichert.
    consents: { cloudflare: true, posthog: true, "google-analytics": true, sentry: true, meta: true },
  });
  const r = readCmp();
  assert.equal(r.state?.ad_storage, "denied");
  assert.equal(r.state?.analytics_storage, "denied");
});

test("Klaro: unbekannte Zwecke behaupten nichts, weder granted noch denied", () => {
  leer();
  const services = [
    { name: "intercom", purposes: ["livechat"] },
    { name: "googleFonts", purposes: ["styling"] },
    { name: "facebook", purposes: ["social"] },
  ];
  const alleJa = { intercom: true, googleFonts: true, facebook: true };
  klaroAttrappe({ confirmed: true, config: { services }, consents: alleJa, savedConsents: alleJa });
  assert.deepEqual(readCmp(), { cmp: "klaro", state: null, decided: false });

  // Ein unbekannter Zweck neben einem bekannten verändert dessen Signal nicht.
  leer();
  const mitMessung = [...services, { name: "matomo", purposes: ["analytics"] }];
  const stand = { ...alleJa, matomo: false };
  klaroAttrappe({ confirmed: true, config: { services: mitMessung }, consents: stand, savedConsents: stand });
  assert.deepEqual(readCmp().state, { analytics_storage: "denied" });
});

test("Klaro: eindeutige Dienstnamen zählen auch bei frei benannten Zwecken", () => {
  leer();
  const services = [
    { name: "Google Ads", purposes: ["kampagnen"] },
    { name: "googleAnalytics", purposes: ["eigenes"] },
  ];
  const stand = { "Google Ads": true, googleAnalytics: false };
  klaroAttrappe({ confirmed: true, config: { services }, consents: stand, savedConsents: stand });
  assert.deepEqual(readCmp().state, {
    ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "denied",
  });
});

test("Klaro vor 0.7: die Dienste heissen `apps`", () => {
  leer();
  const stand = { "google-analytics": true };
  klaroAttrappe({ confirmed: true, config: { apps: [{ name: "google-analytics", purposes: ["analytics"] }] }, consents: stand, savedConsents: stand });
  assert.deepEqual(readCmp().state, { analytics_storage: "granted" });
});

test("Klaro: Anwesenheit ohne lesbaren Manager, und vor dem Laden von klaro.js", () => {
  const faelle: [string, unknown][] = [
    ["klaro", {}],
    ["klaro", { getManager: () => { throw new Error("noch keine Konfiguration"); } }],
    ["klaroConfig", { services: [] }],
    ["klaroApiConfigs", []],
  ];
  for (const [k, v] of faelle) {
    leer();
    setze(k, v);
    assert.deepEqual(readCmp(), { cmp: "klaro", state: null, decided: false }, k);
  }
});

test("Klaro: eine Änderung über manager.watch führt zur Neubewertung", () => {
  leer();
  assert.equal(listenKlaro(() => {}), false, "ohne Klaro gibt es nichts anzumelden");

  const { manager, watchers } = klaroAttrappe();
  const gelesen: ReturnType<typeof readCmp>[] = [];
  assert.equal(listenKlaro(() => gelesen.push(readCmp())), true);
  assert.equal(watchers.length, 1);
  assert.equal(readCmp().decided, false);

  // So speichert Klaro (consent-manager.js, saveConsents): erst der Stand,
  // dann confirmed, dann die Nachricht an die Beobachter.
  const stand = { cloudflare: true, posthog: true, "google-analytics": true, sentry: true, meta: true };
  manager.consents = { ...stand };
  manager.savedConsents = { ...stand };
  manager.confirmed = true;
  watchers[0]!.update(manager, "saveConsents", { changes: stand, consents: stand, type: "accept" });

  assert.equal(gelesen.length, 1);
  assert.equal(gelesen[0]!.cmp, "klaro");
  assert.equal(gelesen[0]!.decided, true);
  assert.equal(gelesen[0]!.state?.ad_storage, "granted");
  assert.equal(gelesen[0]!.state?.analytics_storage, "granted");
});
