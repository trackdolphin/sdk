/**
 * Browser-Verhalten unter node --test: Attribution-Rückfall, Consent Mode v2,
 * identify/reset und das Cookie-Gate. Die DOM-Globals sind minimale Stubs —
 * gerade genug, dass das SDK Cookies, localStorage und den Versand sieht.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const cookies = new Map<string, string>();
const store = new Map<string, string>();
const sent: Record<string, unknown>[] = [];
/** Ziel-URL je gesendetem Event — für den Proxy-Weg und den Rückfall. */
const sentTo: string[] = [];
/** Antwort des gefakten Ziels je URL; ohne Eintrag 202. `throw` = Transportfehler. */
const responses = new Map<string, number | "throw">();
const session = new Map<string, string>();
let navEntries: { name: string }[] = [];

/** Wie ein `<iframe sandbox>` ohne allow-same-origin: schon der Zugriff wirft. */
let cookieBlocked = false;

const doc = {
  referrer: "",
  get cookie() {
    if (cookieBlocked) throw new Error("SecurityError: cookies are blocked");
    return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  },
  set cookie(s: string) {
    if (cookieBlocked) throw new Error("SecurityError: cookies are blocked");
    // Nur name=value zählt — Attribute wie expires/path braucht der Stub nicht.
    const pair = s.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  },
};
const loc = { href: "https://shop.test/", hostname: "shop.test", pathname: "/", search: "", protocol: "https:" };

Object.defineProperty(globalThis, "document", { value: doc, configurable: true });
Object.defineProperty(globalThis, "location", { value: loc, configurable: true });
Object.defineProperty(globalThis, "performance", {
  value: { getEntriesByType: (type: string) => (type === "navigation" ? navEntries : []) },
  configurable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
  },
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => session.set(k, String(v)),
    removeItem: (k: string) => session.delete(k),
  },
  configurable: true,
});
// sendBeacon liefert false → das SDK fällt auf fetch zurück, dort fangen wir ab.
Object.defineProperty(globalThis, "navigator", { value: { sendBeacon: () => false }, configurable: true });
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  const status = responses.get(String(url)) ?? 202;
  if (status === "throw") throw new TypeError("Failed to fetch");
  sent.push(JSON.parse(String(init?.body)));
  sentTo.push(String(url));
  return new Response(null, { status });
}) as typeof fetch;

const sdk = await import("./index.ts");
const { captureAttribution, readAttribution, captureTouch, readTouches, sessionId } = await import("./attribution.ts");

/** Wartet, bis `n` Events beim Stub angekommen sind (Hashing ist asynchron). */
async function sentCount(n: number): Promise<void> {
  for (let i = 0; i < 200 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(sent.length, n, "erwartete Anzahl gesendeter Events");
}

function fresh(): void {
  cookieBlocked = false;
  cookies.clear();
  store.clear();
  session.clear();
  responses.clear();
  sent.length = 0;
  sentTo.length = 0;
  navEntries = [];
  loc.search = "";
  loc.pathname = "/";
  loc.href = "https://shop.test/";
  doc.referrer = "";
}

test("Attribution: gclid aus dem Navigations-Eintrag, wenn die Adresszeile leer ist", () => {
  fresh();
  // Next.js hat per replaceState die Query entfernt — location.search ist leer,
  // der Navigations-Eintrag trägt noch die URL, mit der geladen wurde.
  navEntries = [{ name: "https://shop.test/?gclid=Cj0abc123&utm_source=google" }];
  const attr = captureAttribution();
  assert.equal(attr.gclid, "Cj0abc123");
  assert.equal(attr.utm_source, "google");
  assert.equal(readAttribution().gclid, "Cj0abc123", "im Cookie gesichert");
});

test("Attribution: die Adresszeile gewinnt, der Navigations-Eintrag ist nur Rückfall", () => {
  fresh();
  loc.search = "?gclid=aktuell";
  navEntries = [{ name: "https://shop.test/?gclid=alt" }];
  assert.equal(captureAttribution().gclid, "aktuell");
});

test("Attribution: first-touch bleibt — ohne neue Signale wird nichts überschrieben", () => {
  fresh();
  loc.search = "?gclid=erster";
  captureAttribution();
  loc.search = "";
  navEntries = [{ name: "https://shop.test/produkt" }];
  assert.equal(captureAttribution().gclid, "erster");
});

test("Attribution: fehlende oder kaputte Performance-API stört nicht", () => {
  fresh();
  const saved = globalThis.performance;
  Object.defineProperty(globalThis, "performance", { value: undefined, configurable: true });
  assert.doesNotThrow(() => captureAttribution());
  Object.defineProperty(globalThis, "performance", {
    value: { getEntriesByType: () => { throw new Error("kaputt"); } },
    configurable: true,
  });
  assert.doesNotThrow(() => captureAttribution());
  Object.defineProperty(globalThis, "performance", { value: saved, configurable: true });
});

test("ohne setConsent() und ohne Werkzeug: consent trägt nur source: default", async () => {
  // Bis 0.2.0 fehlte das Feld ganz, und die Plugin-Snippets schickten
  // stattdessen die Voreinstellung aus dem dataLayer als „granted". Jetzt
  // steht dran, dass hier niemand entschieden hat — und KEIN Signal wird
  // erfunden.
  const spezifikator = "./index.ts?ohne-consent-default";
  const frisch = (await import(spezifikator)) as typeof sdk;
  fresh();
  frisch.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  frisch.track({ type: "view_item" });
  await sentCount(1);
  assert.deepEqual(sent[0]!.consent, { source: "default", cmp: "" });
});

test("setConsent(true/false) bildet alle vier Consent-Mode-Signale ab, Herkunft api", async () => {
  fresh();
  sdk.init({ endpoint: "https://shop.test/collect", requireConsent: true });
  sdk.track({ type: "view_item" });
  sdk.setConsent(false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, "verweigert → weiter gepuffert");

  sdk.setConsent(true);
  await sentCount(1);
  assert.deepEqual(sent[0]!.consent, {
    ad_storage: "granted",
    analytics_storage: "granted",
    ad_user_data: "granted",
    ad_personalization: "granted",
    source: "api",
    cmp: "",
  });
});

test("Cookiebot entscheidet: die Warteschlange läuft ohne setConsent() an, Herkunft cmp", async () => {
  fresh();
  const g = globalThis as Record<string, unknown>;
  g.Cookiebot = { hasResponse: false, consent: { marketing: false, statistics: false } };
  const spezifikator = "./index.ts?cookiebot";
  const frisch = (await import(spezifikator)) as typeof sdk;
  frisch.init({ endpoint: "https://shop.test/collect", requireConsent: true });
  frisch.track({ type: "view_item" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, "Banner offen: gepuffert, und aus false wird kein denied");

  // Der Besucher klickt „Statistik ja, Marketing nein" — Cookiebot feuert sein Ereignis.
  g.Cookiebot = { hasResponse: true, consent: { marketing: false, statistics: true } };
  frisch.track({ type: "add_to_cart" });
  await sentCount(2);
  assert.deepEqual(sent[0]!.consent, {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
    source: "cmp", cmp: "cookiebot",
  });
  assert.equal(sent[0]!.type, "view_item", "das gepufferte Ereignis zuerst");
  delete g.Cookiebot;
});

test("Klaro lädt nach dem SDK: Anmeldung beim nächsten Blick, dann löst manager.watch die Warteschlange", async () => {
  fresh();
  const g = globalThis as Record<string, unknown>;
  delete g.klaro;
  const spezifikator = "./index.ts?klaro-spaet";
  const frisch = (await import(spezifikator)) as typeof sdk;
  frisch.init({ endpoint: "https://shop.test/collect", requireConsent: true });
  frisch.track({ type: "view_item" });

  // klaro.js ist inzwischen da (primetime-fitness.de lädt es per defer am
  // Ende des Body), aber niemand hat entschieden.
  const watchers: { update: (m: unknown, t: string, d: unknown) => void }[] = [];
  const offen = { cloudflare: true, "google-analytics": false, meta: false };
  const manager: Record<string, unknown> = {
    confirmed: false,
    consents: { ...offen },
    savedConsents: { ...offen },
    config: {
      services: [
        { name: "cloudflare", purposes: ["functional"], required: true },
        { name: "google-analytics", purposes: ["performance"] },
        { name: "meta", purposes: ["marketing"] },
      ],
    },
    watch: (w: { update: (m: unknown, t: string, d: unknown) => void }) => watchers.push(w),
  };
  g.klaro = { getManager: () => manager };
  frisch.track({ type: "add_to_cart" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, "Banner offen: gepuffert, kein erfundenes denied");
  assert.equal(watchers.length, 1, "beim nächsten Blick ins Fenster angemeldet");

  // „Statistik ja, Marketing nein" gespeichert: Klaro benachrichtigt seine
  // Beobachter, ohne dass die Seite setConsent() ruft oder ein Ereignis feuert.
  const stand = { cloudflare: true, "google-analytics": true, meta: false };
  manager.consents = { ...stand };
  manager.savedConsents = { ...stand };
  manager.confirmed = true;
  watchers[0]!.update(manager, "saveConsents", { changes: stand, consents: stand, type: "save" });
  await sentCount(2);
  assert.deepEqual(sent[0]!.consent, {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
    source: "cmp", cmp: "klaro",
  });
  assert.equal(sent[0]!.type, "view_item", "das gepufferte Ereignis zuerst");
  delete g.klaro;
});

test("Klaro mit setConsent() der Anwendung (der primetime-Einbau): Herkunft api, Werkzeug klaro", async () => {
  fresh();
  const g = globalThis as Record<string, unknown>;
  g.klaro = { getManager: () => ({ confirmed: false, consents: {}, savedConsents: {}, config: { services: [] }, watch: () => {} }) };
  const spezifikator = "./index.ts?klaro-api";
  const frisch = (await import(spezifikator)) as typeof sdk;
  frisch.init({ endpoint: "https://shop.test/collect", requireConsent: true });
  frisch.setConsent({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
  frisch.track({ type: "page_view" });
  await sentCount(1);
  assert.deepEqual(sent[0]!.consent, {
    ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted",
    source: "api", cmp: "klaro",
  });
  delete g.klaro;
});

test("Consent-Mode-default ist eine Voreinstellung: Signale ja, aber source default und kein Klartext", async () => {
  // Der Primetime-Fall, jetzt mit dem SDK statt dem Plugin-Snippet.
  fresh();
  const g = globalThis as Record<string, unknown>;
  g.dataLayer = [["consent", "default", { ad_storage: "granted", analytics_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }]];
  const spezifikator = "./index.ts?consent-mode-default";
  const frisch = (await import(spezifikator)) as typeof sdk;
  frisch.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  await frisch.identify({ email: "anna@example.de", name: "Anna Müller" });
  await sentCount(1);
  assert.equal(sent[0]!.consent && (sent[0]!.consent as { source: string }).source, "default");
  assert.equal((sent[0]!.consent as { cmp: string }).cmp, "google-consent-mode");
  assert.equal((sent[0]!.consent as { ad_storage: string }).ad_storage, "granted", "die Voreinstellung wird gemeldet, nicht verschwiegen");
  assert.equal("contact_name" in sent[0]!, false, "eine Voreinstellung gibt keinen Klartext frei");

  // Ein update aus dem Banner macht daraus eine Entscheidung.
  (g.dataLayer as unknown[]).push(["consent", "update", { ad_storage: "denied", analytics_storage: "granted" }]);
  frisch.track({ type: "page_view" });
  await sentCount(2);
  assert.equal((sent[1]!.consent as { source: string }).source, "cmp");
  assert.equal((sent[1]!.consent as { ad_storage: string }).ad_storage, "denied");
  delete g.dataLayer;
});

test("granulare Einwilligung: analytics_storage allein reicht zum Senden, das Objekt wandert mit", async () => {
  fresh();
  sdk.init({ endpoint: "https://shop.test/collect", requireConsent: true });
  sdk.track({ type: "view_item" });

  const nurNutzerdaten = { ad_storage: "denied", analytics_storage: "denied", ad_user_data: "granted" } as const;
  sdk.setConsent(nurNutzerdaten);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, "ohne Storage-Signal bleibt die Warteschlange stehen");

  const analytics = { ad_storage: "denied", analytics_storage: "granted", ad_user_data: "denied", ad_personalization: "denied" } as const;
  sdk.setConsent(analytics);
  await sentCount(1);
  assert.deepEqual(sent[0]!.consent, { ...analytics, source: "api", cmp: "" });

  sdk.track({ type: "add_to_cart" });
  await sentCount(2);
  assert.deepEqual(sent[1]!.consent, { ...analytics, source: "api", cmp: "" }, "auch spätere Events tragen den Zustand");
});

test("identify: speichert nur Hashes, sendet ein identify-Event und reichert danach jedes Event an", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);

  await sdk.identify({
    email: "Kunde@Example.de",
    phone: "0176 1234 5678",
    externalId: "kunde_42",
    traits: { plan: "pro", newsletter: true, bestellungen: 3 },
  });

  const raw = store.get("_td_id") ?? "";
  assert.ok(raw, "Identität liegt unter _td_id");
  assert.doesNotMatch(raw, /example\.de|1234/i, "kein Klartext im Speicher");
  const stored = JSON.parse(raw);
  assert.match(stored.em, /^[a-f0-9]{64}$/);
  assert.match(stored.ph, /^[a-f0-9]{64}$/);
  assert.match(stored.ph_e164, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.ph, stored.ph_e164, "Meta ohne, Google mit Plus");
  assert.equal(stored.external_id, "kunde_42");

  await sentCount(1);
  const idEvent = sent[0]!;
  assert.equal(idEvent.type, "identify");
  assert.deepEqual(idEvent.traits, { plan: "pro", newsletter: true, bestellungen: 3 });
  assert.equal(idEvent.em, stored.em);
  assert.equal(idEvent.external_id, "kunde_42");
  assert.equal("email" in idEvent, false, "Klartext verlässt den Browser nie");

  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.equal(sent[1]!.em, stored.em);
  assert.equal(sent[1]!.ph, stored.ph);
  assert.equal(sent[1]!.ph_e164, stored.ph_e164);
  assert.equal(sent[1]!.external_id, "kunde_42");
  assert.equal("traits" in sent[1]!, false, "traits nur am identify-Event");
});

test("identify: was das Event selbst mitbringt, hat Vorrang vor der gespeicherten Identität", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);
  await sdk.identify({ email: "a@example.de", externalId: "a" });
  await sentCount(1);

  sdk.track({ type: "purchase", email: "b@example.de", external_id: "b" });
  await sentCount(2);
  const { hashEmail } = sdk;
  assert.equal(sent[1]!.em, await hashEmail("b@example.de"));
  assert.equal(sent[1]!.external_id, "b");
});

test("reset() vergisst die Identität — das nächste Event ist wieder anonym", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);
  await sdk.identify({ email: "a@example.de", externalId: "a" });
  await sentCount(1);

  sdk.reset();
  assert.equal(store.has("_td_id"), false);
  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.equal("em" in sent[1]!, false);
  assert.equal("external_id" in sent[1]!, false);
});

test("Cookie-Gate: ohne Einwilligung weder _td_vid-Cookie noch visitor_id", async () => {
  fresh();
  // Explizit verweigert — ein früherer Zustand aus anderen Tests soll nicht zufällig passen.
  sdk.setConsent(false);
  // Fremde Collector-URL → das SDK schreibt das Cookie selbst („client“).
  sdk.init({ modus: "immer", endpoint: "https://abc123.trdph.com/collect", visitorCookieRequiresConsent: true });

  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal("visitor_id" in sent[0]!, false);
  assert.equal(cookies.has("_td_vid"), false, "kein Cookie vor der Einwilligung");

  sdk.setConsent({ ad_storage: "granted", analytics_storage: "denied" });
  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.ok(cookies.has("_td_vid"), "Cookie erst mit Einwilligung");
  assert.equal(sent[1]!.visitor_id, cookies.get("_td_vid"));
});

test("Cookie-Gate: standardmäßig aus — visitor_id kommt sofort", async () => {
  fresh();
  sdk.setConsent(false);
  sdk.init({ modus: "immer", endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"));
  assert.equal(sent[0]!.visitor_id, cookies.get("_td_vid"));
});

test("Proxy-Weg: relativer endpoint wird gegen die Seite aufgelöst", async () => {
  fresh();
  sdk.setConsent(true);
  sdk.init({ modus: "immer", endpoint: "/td" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://shop.test/td");
});

test("Besucherkennung „server“: bei relativem endpoint schreibt das SDK kein Cookie, liest aber ein vorhandenes", async () => {
  fresh();
  sdk.setConsent(true);
  sdk.init({ modus: "immer", endpoint: "/td" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(cookies.has("_td_vid"), false, "der Proxy vergibt die Kennung, nicht das SDK");
  assert.equal("visitor_id" in sent[0]!, false);

  // Der Proxy hat per Set-Cookie eine Kennung vergeben — ab jetzt trägt sie jedes Event.
  cookies.set("_td_vid", "vom-server-1234");
  sdk.track({ type: "add_to_cart" });
  await sentCount(2);
  assert.equal(sent[1]!.visitor_id, "vom-server-1234");
});

test("Besucherkennung „client“: bei fremder Collector-URL schreibt das SDK das Cookie selbst — und lässt sich umschalten", async () => {
  fresh();
  sdk.setConsent(true);
  sdk.init({ modus: "immer", endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"));
  assert.equal(sent[0]!.visitor_id, cookies.get("_td_vid"));

  fresh();
  sdk.init({ modus: "immer", endpoint: "https://abc123.trdph.com/collect", visitorId: "server" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(cookies.has("_td_vid"), false, "ausdrücklich server: kein JS-Cookie");

  fresh();
  sdk.init({ modus: "immer", endpoint: "/td", visitorId: "client" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"), "ausdrücklich client: Cookie trotz Proxy");
});

test("Rückfall: erstes Event prüft die Proxy-Route; antwortet sie 404, geht es direkt an den Collector — für die ganze Sitzung", async () => {
  fresh();
  sdk.setConsent(true);
  responses.set("https://shop.test/td", 404);
  sdk.init({ modus: "immer", endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });

  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.deepEqual(sentTo, ["https://shop.test/td", "https://abc123.trdph.com/collect"], "erst die Probe, dann der Rückfall");
  assert.equal(session.get("_td_tx"), "fallback");

  sdk.track({ type: "add_to_cart" });
  await sentCount(3);
  assert.equal(sentTo[2], "https://abc123.trdph.com/collect", "Rest der Sitzung direkt");
  // Im Rückfall setzt kein Server ein Cookie — dann vergibt das SDK eine kurzlebige Kennung.
  assert.ok(cookies.has("_td_vid"));
  assert.equal(sent[2]!.visitor_id, cookies.get("_td_vid"));
});

test("Rückfall: Transportfehler und 5xx lösen ihn aus, 204/202/413 nicht", async () => {
  fresh();
  sdk.setConsent(true);
  responses.set("https://shop.test/td", "throw");
  sdk.init({ modus: "immer", endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://abc123.trdph.com/collect");
  assert.equal(session.get("_td_tx"), "fallback");

  fresh();
  responses.set("https://shop.test/td", 503);
  sdk.init({ modus: "immer", endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.equal(session.get("_td_tx"), "fallback");

  for (const ok of [204, 202, 413]) {
    fresh();
    responses.set("https://shop.test/td", ok);
    sdk.init({ modus: "immer", endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
    sdk.track({ type: "view_item" });
    sdk.track({ type: "add_to_cart" });
    await sentCount(2);
    assert.deepEqual(sentTo, ["https://shop.test/td", "https://shop.test/td"], `Status ${ok}: Proxy trägt`);
    assert.equal(session.get("_td_tx"), "same-origin");
  }
});

test("Rückfall: die Entscheidung überlebt einen Seitenwechsel innerhalb der Sitzung", async () => {
  fresh();
  sdk.setConsent(true);
  session.set("_td_tx", "fallback");
  sdk.init({ modus: "immer", endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://abc123.trdph.com/collect", "keine neue Probe, direkt der Rückfall");

  // Ohne fallbackEndpoint gibt es keine Probe und keinen Rückfall — egal, was die Sitzung sagt.
  fresh();
  session.set("_td_tx", "fallback");
  sdk.init({ modus: "immer", endpoint: "/td" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://shop.test/td");
});

/* ------------------------------------------------------------------ *
 * Zusage „das SDK wirft nie“ — die Wege, auf denen ein Tracking-Fehler
 * sonst in der Bestellstrecke der einbindenden Seite landen würde.
 * ------------------------------------------------------------------ */

/** Läuft `fn` ohne crypto.subtle — unsicherer Kontext, alte WebView. */
async function withoutSubtle(fn: () => Promise<void>): Promise<void> {
  const saved = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    value: { randomUUID: () => saved.randomUUID() },
    configurable: true,
  });
  try {
    await fn();
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true });
  }
}

test("init() wirft nicht, wenn der Cookie-Zugriff gesperrt ist (Sandbox-Iframe)", async () => {
  fresh();
  cookieBlocked = true;
  assert.doesNotThrow(() => sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" }));
  // Und der Versand läuft weiter — nur ohne Attribution und ohne Besucherkennung.
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sent[0]!.type, "view_item");
});

test("track() wirft nicht und sendet weiter, wenn das Hashen scheitert", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  await withoutSubtle(async () => {
    assert.doesNotThrow(() => sdk.track({ type: "purchase", value: 89.9, email: "kunde@example.de" }));
    await sentCount(1);
  });
  assert.equal(sent[0]!.value, 89.9, "die Conversion zählt");
  assert.equal("em" in sent[0]!, false, "nur das Match-Signal fehlt");
  assert.equal("email" in sent[0]!, false, "Klartext geht nie raus");
});

test("identify() lehnt nie ab — auch ohne crypto.subtle", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  await withoutSubtle(async () => {
    // Der typische Aufruf im Absende-Handler: await mitten im Formular.
    await sdk.identify({ email: "kunde@example.de", externalId: "kunde-42" });
  });
  await sentCount(1);
  assert.equal(sent[0]!.type, "identify");
  assert.equal(sent[0]!.external_id, "kunde-42", "was ohne Hashing ging, bleibt erhalten");
});

test("kein Wurf, wenn das Ziel unerreichbar ist und kein Rückfall greift", async () => {
  fresh();
  responses.set("https://shop.test/collect", "throw");
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  assert.doesNotThrow(() => sdk.track({ type: "purchase", value: 10 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 0, "verloren ist das Event, nicht der Kauf");
});

/**
 * Die Klartext-Bremse. Der wichtigste Fall ist der erste: eine Seite, auf der
 * nie jemand `setConsent()` gerufen hat. Das ist der Normalfall in einem Shop
 * ohne Banner — dort darf ein Name den Browser nicht verlassen, obwohl das
 * Ereignis selbst wie bisher rausgeht.
 */
test("identify: ohne Einwilligungsentscheidung kein Klartext im Payload", async () => {
  // Eigene Modul-Instanz: `consentState` ist Modulzustand und hier durch die
  // vorigen Tests längst gesetzt. Mit dem Query-Suffix lädt Node das Modul
  // erneut — nur so lässt sich „es wurde nie gefragt" überhaupt prüfen.
  // Der Spezifikator steht in einer Variablen, damit TypeScript ihn nicht
  // aufzulösen versucht — die Query-Endung kennt nur der Node-Loader.
  const spezifikator = "./index.ts?ohne-consent";
  const frisch = (await import(spezifikator)) as typeof sdk;
  fresh();
  frisch.init({ modus: "immer", endpoint: "https://shop.test/collect" });

  await frisch.identify({ email: "anna@example.de", name: "Anna Müller", externalId: "k42" });
  await sentCount(1);
  const ev = sent[0]!;
  assert.equal(ev.type, "identify");
  assert.equal("contact_email" in ev, false, "Klartext-E-Mail ohne Einwilligung");
  assert.equal("contact_name" in ev, false, "Klartext-Name ohne Einwilligung");
  // Die Hashes gehen unverändert raus — die Bremse kostet den Namen, nicht die Zuordnung.
  assert.match(String(ev.em), /^[a-f0-9]{64}$/);
  assert.equal(ev.external_id, "k42");
});

test("abgelehnte Einwilligung: nichts geht raus — und beim späteren Ja gilt die Erlaubnis von dann", async () => {
  fresh();
  // Modus 1: Ohne Ja passiert nichts, auch nicht anonym.
  sdk.init({ modus: "nach_einwilligung", endpoint: "https://shop.test/collect" });
  sdk.setConsent(false);
  await sdk.identify({ email: "anna@example.de", name: "Anna Müller" });
  // Bei verweigertem Speicher wartet das SDK ohnehin mit ALLEM — nicht nur
  // mit dem Klartext.
  assert.equal(sent.length, 0);

  // Das Nachsenden entscheidet neu: Die Bremse sitzt im Versand, nicht im
  // Aufruf. Sonst hinge am nachgeholten Event der Zustand von vorhin.
  sdk.setConsent(true);
  await sentCount(1);
  assert.equal(sent[0]!.contact_email, "anna@example.de");
  assert.equal(sent[0]!.contact_name, "Anna Müller");
});

test("identify: mit Einwilligung stehen Name und E-Mail am identify-Event — und nur dort", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);
  await sdk.identify({ email: "Anna@Example.de", name: "Anna Müller", externalId: "k42" });
  await sentCount(1);
  assert.equal(sent[0]!.contact_email, "Anna@Example.de");
  assert.equal(sent[0]!.contact_name, "Anna Müller");

  // Der Klartext bleibt im Arbeitsspeicher, nicht im localStorage.
  assert.doesNotMatch(store.get("_td_id") ?? "", /Anna|Example\.de/i);

  // Und er hängt nicht an jedem weiteren Ereignis.
  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.equal("contact_email" in sent[1]!, false);
  assert.equal("contact_name" in sent[1]!, false);
});

test("reset() vergisst auch den Klartext", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);
  await sdk.identify({ email: "anna@example.de", name: "Anna Müller" });
  await sentCount(1);

  sdk.reset();
  await sdk.identify({ externalId: "k99" });
  await sentCount(2);
  assert.equal("contact_name" in sent[1]!, false, "Name des vorigen Nutzers am selben Gerät");
  assert.equal("contact_email" in sent[1]!, false);
});

test("Kontaktliste: Anzeigenklick, dann Direktbesuch, dann Newsletter — drei Besuche, zwei Kontakte", () => {
  fresh();
  loc.search = "?gclid=Cj0abc&utm_source=google&utm_medium=cpc&utm_campaign=Sommer";
  loc.pathname = "/landing";
  doc.referrer = "https://www.google.com/";
  let touches = captureTouch();
  assert.equal(touches.length, 1);
  assert.deepEqual(
    { ...touches[0], at: "x" },
    { at: "x", source: "google", medium: "cpc", campaign: "sommer", click: "gclid", referrer: "google.com", landing: "/landing" },
  );
  // Direkt zurück: kein Kontakt, der Klick bleibt der letzte.
  loc.search = "";
  doc.referrer = "";
  touches = captureTouch();
  assert.equal(touches.length, 1);
  // Verweis von der eigenen Seite zählt nicht als Herkunft.
  doc.referrer = "https://shop.test/start";
  assert.equal(captureTouch().length, 1);
  // Newsletter: zweiter Kontakt, und die Liste steht im Cookie.
  loc.search = "?utm_source=klaviyo&utm_medium=email";
  touches = captureTouch();
  assert.equal(touches.length, 2);
  assert.equal(readTouches()[1]?.source, "klaviyo");
  assert.equal(readTouches()[0]?.click, "gclid", "der erste Kontakt bleibt vorn");
});

test("Kontaktliste: die Query aus dem Navigations-Eintrag zählt, wenn die Adresszeile leer ist", () => {
  fresh();
  navEntries = [{ name: "https://shop.test/?fbclid=IwAR123" }];
  assert.equal(captureTouch()[0]?.click, "fbclid");
});

test("Kontaktliste und Sitzung stehen an jedem Event", async () => {
  fresh();
  loc.search = "?utm_source=chatgpt.com";
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.track({ type: "page_view" });
  sdk.track({ type: "lead" });
  await sentCount(2);
  const [a, b] = sent as Array<{ touches: unknown[]; session_id: string }>;
  assert.equal((a!.touches[0] as { source: string }).source, "chatgpt.com");
  assert.equal(a!.session_id, b!.session_id, "dieselbe Sitzung");
  assert.ok(a!.session_id.length >= 10);
});

test("Sitzung: nach 30 Minuten Stille eine neue Kennung", () => {
  fresh();
  const erste = sessionId();
  assert.ok(erste);
  session.set("_td_sid", `${erste}.${Date.now() - 31 * 60 * 1000}`);
  assert.notEqual(sessionId(), erste);
});

test("Kontaktliste: ohne Cookie-Zugriff stört nichts", () => {
  fresh();
  cookieBlocked = true;
  loc.search = "?gclid=x";
  assert.doesNotThrow(() => captureTouch());
  assert.deepEqual(readTouches(), []);
  cookieBlocked = false;
});

// ---------------------------------------------------------------------------
// Die drei Modi (docs/drei-modi.md).
//
// Bis 0.3.x kannte das SDK nur „puffern oder senden" und sendete ohne
// `requireConsent` sofort mit Kennungen. Das Plugin-Snippet konnte längst
// anonym messen; jetzt kann es das SDK auch, und die Vorgabe ist der strenge
// Modus statt der bequeme.
// ---------------------------------------------------------------------------

test("Modus nach_einwilligung ist die Vorgabe: ohne Angabe schweigt die Seite", async () => {
  fresh();
  // Fremder Host: Dann vergibt das SDK die Besucherkennung selbst und man
  // sieht am Ereignis, dass nach dem Ja wieder voll gemessen wird.
  sdk.init({ endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "page_view" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0, "kein Ereignis vor der Entscheidung");
  assert.equal(cookies.has("_td_vid"), false, "und kein Cookie");
  sdk.setConsent(true);
  await sentCount(1);
  assert.equal(sent[0]!.type, "page_view", "das gepufferte Ereignis geht nach dem Ja hinaus");
  assert.ok(sent[0]!.visitor_id, "und dann mit Kennung");
});

test("Modus sammeln: alles geht mit, was ohne Zugriff aufs Endgerät bekannt ist", async () => {
  fresh();
  loc.href = "https://shop.test/produkt?gclid=geheim&utm_source=google";
  loc.search = "?gclid=geheim&utm_source=google";
  loc.pathname = "/produkt";
  doc.referrer = "https://ref.test/";
  sdk.init({ modus: "sammeln", endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "page_view" });
  await sentCount(1);
  const ev = sent[0]!;
  // Adresse, Herkunft und Klick-ID stehen in diesem Aufruf, nicht auf dem Gerät.
  assert.equal(ev.url, "https://shop.test/produkt?gclid=geheim&utm_source=google");
  assert.equal(ev.referrer, "https://ref.test/");
  assert.equal(ev.gclid, "geheim", "die Klick-ID kommt aus der Adresse, nicht aus dem Cookie");
  // Und nichts, wofür man das Gerät anfassen müsste.
  for (const k of ["visitor_id", "session_id", "fbp", "ga_client_id", "touches", "external_id"]) {
    assert.equal(k in ev, false, `${k} setzt Gerätezugriff voraus und darf nicht mitgehen`);
  }
  assert.equal((ev.consent as { source: string }).source, "default", "niemand hat entschieden, und das steht dran");
  assert.equal(cookies.has("_td_vid"), false, "kein Besucher-Cookie");
  assert.equal(cookies.has("_td_attr"), false, "kein Attributions-Cookie");
  assert.equal(session.size, 0, "keine Sitzung");
});

test("Modus sammeln: eine Ablehnung hält die Messung nicht an, sie hält nur das Gerät sauber", async () => {
  fresh();
  loc.search = "?gclid=geheim";
  sdk.init({ modus: "sammeln", endpoint: "https://abc123.trdph.com/collect" });
  sdk.setConsent(false);
  sdk.track({ type: "page_view" });
  await sentCount(1);
  assert.equal(sent[0]!.gclid, "geheim");
  assert.equal("visitor_id" in sent[0]!, false);
  assert.equal(cookies.has("_td_vid"), false);
});

test("Modus immer: Kennungen, Sitzung und Attribution vom ersten Ereignis an", async () => {
  fresh();
  loc.search = "?gclid=geheim";
  sdk.init({ modus: "immer", endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "page_view" });
  await sentCount(1);
  const ev = sent[0]!;
  assert.ok(ev.visitor_id, "Besucherkennung sofort");
  assert.ok(ev.session_id, "Sitzung sofort");
  assert.equal(ev.gclid, "geheim", "die Klick-ID geht mit");
  assert.ok(cookies.has("_td_attr"), "die Attribution wird gesichert");
  assert.equal((ev.consent as { source: string }).source, "default");
});

test("requireConsent bleibt die Kurzform: true ist Modus 1, ein ausdrückliches false ist Modus 3", async () => {
  fresh();
  sdk.init({ endpoint: "https://abc123.trdph.com/collect", requireConsent: true });
  sdk.track({ type: "page_view" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0);
  // Die Warteschlange leeren, sonst trüge sie ins nächste Szenario hinein.
  sdk.setConsent(true);
  await sentCount(1);

  fresh();
  sdk.init({ endpoint: "https://abc123.trdph.com/collect", requireConsent: false });
  sdk.track({ type: "page_view" });
  await sentCount(1);
  assert.ok(sent[0]!.visitor_id, "wie bis 0.3.x: sofort und mit Kennung");
});

test("normalizeModus: der alte Name anonym wird sammeln, alles Unbekannte wird streng", () => {
  assert.equal(sdk.normalizeModus("anonym"), "sammeln", "Collector-Stände von vor dem 11.9. sprechen noch den alten Namen");
  assert.equal(sdk.normalizeModus("sammeln"), "sammeln");
  assert.equal(sdk.normalizeModus("immer"), "immer");
  for (const krumm of ["eigen", "", undefined, null, 42]) {
    assert.equal(sdk.normalizeModus(krumm), "nach_einwilligung");
  }
});

test("identify: Vor- und Nachname werden gehasht und tragen jedes weitere Event", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);

  await sdk.identify({ email: "anna@example.de", firstName: "Anna", lastName: "Müller" });

  const raw = store.get("_td_id") ?? "";
  assert.doesNotMatch(raw, /anna|müller/i, "kein Klartext im Speicher, auch nicht der Name");
  const stored = JSON.parse(raw);
  assert.match(stored.fn, /^[a-f0-9]{64}$/);
  assert.match(stored.ln, /^[a-f0-9]{64}$/);
  assert.equal(stored.fn, await sdk.hashName("anna"), "normalisiert, nicht roh gehasht");
  assert.equal(stored.ln, await sdk.hashName("MÜLLER"), "Kleinschreibung entscheidet nicht");

  await sentCount(1);
  assert.equal(sent[0]!.fn, stored.fn);
  assert.equal(sent[0]!.ln, stored.ln);

  // Der Kauf ist das Ereignis, das zählt — er muss die Signale mittragen.
  sdk.track({ type: "purchase", value: 49 });
  await sentCount(2);
  assert.equal(sent[1]!.fn, stored.fn);
  assert.equal(sent[1]!.ln, stored.ln);
});

test("identify: mit Einwilligung geht der Klartext getrennt mit, der ganze Name wird gebildet", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);

  await sdk.identify({ email: "anna@example.de", firstName: "Anna", lastName: "van der Berg" });
  await sentCount(1);
  assert.equal(sent[0]!.contact_first_name, "Anna");
  assert.equal(sent[0]!.contact_last_name, "van der Berg");
  assert.equal(sent[0]!.contact_name, "Anna van der Berg", "ganzer Name aus den Teilen gebildet");
  assert.equal(sent[0]!.contact_email, "anna@example.de");

  // Nur am identify: Jeder Seitenaufruf trüge sonst eine Kopie desselben Namens.
  sdk.track({ type: "page_view" });
  await sentCount(2);
  assert.equal("contact_first_name" in sent[1]!, false);
  assert.equal("contact_last_name" in sent[1]!, false);
});

test("identify: ein übergebener ganzer Name wird NICHT in Vor- und Nachname zerlegt", async () => {
  // „van der Berg" und „Maria Anna" gingen dabei schief, und der Fehler fiele
  // niemandem auf. Lieber kein Vorname als ein falscher.
  fresh();
  // `fresh()` leert Speicher und Cookies, nicht den flüchtigen Klartext im
  // Modul — in einer echten Seite wäre der mit dem Seitenwechsel weg.
  sdk.reset();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);

  await sdk.identify({ email: "anna@example.de", name: "Anna van der Berg" });
  await sentCount(1);
  assert.equal(sent[0]!.contact_name, "Anna van der Berg");
  assert.equal("contact_first_name" in sent[0]!, false);
  assert.equal("contact_last_name" in sent[0]!, false);
  assert.equal("fn" in sent[0]!, false, "ohne getrennte Angabe auch kein Namens-Hash");
  assert.equal("ln" in sent[0]!, false);
});

test("identify: OHNE Einwilligung bleibt der Klartext hier, die Hashes gehen wie bisher raus", async () => {
  fresh();
  sdk.reset();
  // modus „immer": Das Ereignis geht raus, aber niemand hat setConsent() gerufen.
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });

  await sdk.identify({ email: "anna@example.de", firstName: "Anna", lastName: "Müller" });
  await sentCount(1);
  assert.equal("contact_first_name" in sent[0]!, false, "ohne Entscheidung kein lesbarer Vorname");
  assert.equal("contact_last_name" in sent[0]!, false);
  assert.equal("contact_name" in sent[0]!, false);
  assert.equal("contact_email" in sent[0]!, false);
  assert.match(String(sent[0]!.fn), /^[a-f0-9]{64}$/, "die Hashes gehen wie bisher");
  assert.match(String(sent[0]!.ln), /^[a-f0-9]{64}$/);
});

test("reset() vergisst auch Namens-Hash und getrennten Klartext", async () => {
  fresh();
  sdk.init({ modus: "immer", endpoint: "https://shop.test/collect" });
  sdk.setConsent(true);
  await sdk.identify({ firstName: "Anna", lastName: "Müller" });
  await sentCount(1);

  sdk.reset();
  sdk.track({ type: "identify" });
  await sentCount(2);
  assert.equal("fn" in sent[1]!, false);
  assert.equal("ln" in sent[1]!, false);
  assert.equal("contact_first_name" in sent[1]!, false);
  assert.equal("contact_last_name" in sent[1]!, false);
});
