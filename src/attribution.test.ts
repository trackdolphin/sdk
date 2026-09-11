import { test } from "node:test";
import assert from "node:assert/strict";
import { kontaktAus, kontakteZusammenfuehren, MAX_TOUCHES as PAKET_MAX, type Touchpoint } from "@trackdolphin/attribution";
import { mergeTouches, touchFrom, MAX_TOUCHES } from "./attribution.ts";

/**
 * Zwei Fassungen derselben Regel — eine im SDK (ohne Abhängigkeiten, es
 * geht in fremde Browser), eine im Attribution-Paket (für Server und
 * Nachtrag). Dieser Test lässt beide über dieselbe Besuchsfolge laufen und
 * verlangt dasselbe Ergebnis. Derselbe Preis wie bei `event-typen.test.ts`:
 * Die zweite Liste gibt es, aber sie kann nicht still abweichen.
 */
test("SDK und Attribution-Paket führen Kontakte gleich zusammen", () => {
  assert.equal(MAX_TOUCHES, PAKET_MAX);
  const besuche: Touchpoint[] = [
    { at: "2026-09-01T10:00:00Z", click: "gclid", source: "google", medium: "cpc" },
    { at: "2026-09-01T10:05:00Z" },
    { at: "2026-09-01T10:10:00Z", click: "gclid", source: "google", medium: "cpc" },
    { at: "2026-09-02T10:10:00Z", click: "gclid", source: "google", medium: "cpc" },
    { at: "2026-09-03T08:00:00Z", referrer: "perplexity.ai" },
    ...Array.from({ length: 15 }, (_, i) => ({ at: `2026-09-04T${String(10 + (i % 10)).padStart(2, "0")}:00:00Z`, source: `s${i}` })),
    { at: "2026-09-05T09:00:00Z", source: "klaviyo", medium: "email" },
  ];
  let sdk: Touchpoint[] = [];
  let paket: Touchpoint[] = [];
  for (const b of besuche) {
    sdk = mergeTouches(sdk, b);
    paket = kontakteZusammenfuehren(paket, b);
    assert.deepEqual(sdk, paket, JSON.stringify(b));
  }
  assert.equal(sdk.length, MAX_TOUCHES);
  assert.equal(sdk[0]?.click, "gclid");
  assert.equal(sdk[MAX_TOUCHES - 1]?.source, "klaviyo");
});

test("SDK und Attribution-Paket bauen aus demselben Seitenaufruf denselben Kontakt", () => {
  const faelle = [
    { search: "?utm_source=Google&utm_medium=CPC&gclid=x&utm_campaign=S", referrer: "https://www.google.com/", path: "/l", host: "www.shop.de" },
    { search: "", referrer: "https://join.shop.de/start", path: "/", host: "www.shop.de" },
    { search: "", referrer: "https://shop.co.uk/", path: "/", host: "other.co.uk" },
    { search: "?fbclid=1", referrer: "https://l.facebook.com/l.php", path: "/x", host: "shop.de" },
    { search: "?utm_id=42", referrer: "", path: "/", host: "shop.de" },
  ];
  for (const f of faelle) {
    const sdk = touchFrom(f.search, f.referrer, f.path, f.host, "2026-09-09T10:00:00Z");
    const paket = kontaktAus({ search: f.search, referrer: f.referrer, path: f.path, eigenerHost: f.host, at: "2026-09-09T10:00:00Z" });
    assert.deepEqual(sdk, paket, JSON.stringify(f));
  }
});
