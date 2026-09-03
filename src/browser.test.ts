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

const doc = {
  referrer: "",
  get cookie() {
    return [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  },
  set cookie(s: string) {
    // Nur name=value zählt — Attribute wie expires/path braucht der Stub nicht.
    const pair = s.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    cookies.set(pair.slice(0, i), pair.slice(i + 1));
  },
};
const loc = { href: "https://shop.test/", pathname: "/", search: "", protocol: "https:" };

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
const { captureAttribution, readAttribution } = await import("./attribution.ts");

/** Wartet, bis `n` Events beim Stub angekommen sind (Hashing ist asynchron). */
async function sentCount(n: number): Promise<void> {
  for (let i = 0; i < 200 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 2));
  assert.equal(sent.length, n, "erwartete Anzahl gesendeter Events");
}

function fresh(): void {
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

test("ohne setConsent() fehlt das Feld consent im Event", async () => {
  fresh();
  sdk.init({ endpoint: "https://shop.test/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal("consent" in sent[0]!, false);
});

test("setConsent(true/false) bildet alle vier Consent-Mode-Signale ab", async () => {
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
  });
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
  assert.deepEqual(sent[0]!.consent, analytics);

  sdk.track({ type: "add_to_cart" });
  await sentCount(2);
  assert.deepEqual(sent[1]!.consent, analytics, "auch spätere Events tragen den Zustand");
});

test("identify: speichert nur Hashes, sendet ein identify-Event und reichert danach jedes Event an", async () => {
  fresh();
  sdk.init({ endpoint: "https://shop.test/collect" });
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
  sdk.init({ endpoint: "https://shop.test/collect" });
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
  sdk.init({ endpoint: "https://shop.test/collect" });
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
  sdk.init({ endpoint: "https://abc123.trdph.com/collect", visitorCookieRequiresConsent: true });

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
  sdk.init({ endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"));
  assert.equal(sent[0]!.visitor_id, cookies.get("_td_vid"));
});

test("Proxy-Weg: relativer endpoint wird gegen die Seite aufgelöst", async () => {
  fresh();
  sdk.setConsent(true);
  sdk.init({ endpoint: "/td" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://shop.test/td");
});

test("Besucherkennung „server“: bei relativem endpoint schreibt das SDK kein Cookie, liest aber ein vorhandenes", async () => {
  fresh();
  sdk.setConsent(true);
  sdk.init({ endpoint: "/td" });
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
  sdk.init({ endpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"));
  assert.equal(sent[0]!.visitor_id, cookies.get("_td_vid"));

  fresh();
  sdk.init({ endpoint: "https://abc123.trdph.com/collect", visitorId: "server" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(cookies.has("_td_vid"), false, "ausdrücklich server: kein JS-Cookie");

  fresh();
  sdk.init({ endpoint: "/td", visitorId: "client" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.ok(cookies.has("_td_vid"), "ausdrücklich client: Cookie trotz Proxy");
});

test("Rückfall: erstes Event prüft die Proxy-Route; antwortet sie 404, geht es direkt an den Collector — für die ganze Sitzung", async () => {
  fresh();
  sdk.setConsent(true);
  responses.set("https://shop.test/td", 404);
  sdk.init({ endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });

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
  sdk.init({ endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://abc123.trdph.com/collect");
  assert.equal(session.get("_td_tx"), "fallback");

  fresh();
  responses.set("https://shop.test/td", 503);
  sdk.init({ endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(2);
  assert.equal(session.get("_td_tx"), "fallback");

  for (const ok of [204, 202, 413]) {
    fresh();
    responses.set("https://shop.test/td", ok);
    sdk.init({ endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
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
  sdk.init({ endpoint: "/td", fallbackEndpoint: "https://abc123.trdph.com/collect" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://abc123.trdph.com/collect", "keine neue Probe, direkt der Rückfall");

  // Ohne fallbackEndpoint gibt es keine Probe und keinen Rückfall — egal, was die Sitzung sagt.
  fresh();
  session.set("_td_tx", "fallback");
  sdk.init({ endpoint: "/td" });
  sdk.track({ type: "view_item" });
  await sentCount(1);
  assert.equal(sentTo[0], "https://shop.test/td");
});
