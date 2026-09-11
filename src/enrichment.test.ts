import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTags,
  consentTag,
  deriveChannel,
  MAX_VALUE_LENGTH,
  sanitizeTagValue,
  valueBand,
} from "./enrichment.ts";

test("Klick-ID schlägt UTM: eine gclid ist ein Beleg, utm_source nur eine Behauptung", () => {
  assert.equal(deriveChannel({ gclid: "abc", utm_source: "newsletter", utm_medium: "email" }), "google_paid");
  assert.equal(deriveChannel({ fbclid: "x" }), "meta_paid");
  assert.equal(deriveChannel({ msclkid: "x" }), "microsoft_paid");
  assert.equal(deriveChannel({ epik: "x" }), "pinterest_paid");
  assert.equal(deriveChannel({ oppref: "x" }), "openai_paid");
  assert.equal(deriveChannel({ gbraid: "x" }), "google_paid");
});

test("ohne Klick-ID entscheidet utm_medium über bezahlt/organisch", () => {
  assert.equal(deriveChannel({ utm_source: "google", utm_medium: "cpc" }), "google_paid");
  assert.equal(deriveChannel({ utm_medium: "cpc" }), "paid");
  assert.equal(deriveChannel({ utm_source: "newsletter", utm_medium: "email" }), "newsletter_email");
  assert.equal(deriveChannel({ utm_source: "partnerseite" }), "partnerseite");
});

test("ohne Kampagnensignale trägt die Verweisadresse", () => {
  assert.equal(deriveChannel({}), "direct");
  assert.equal(deriveChannel({ referrer: "https://www.google.de/search?q=schuhe" }), "organic_search");
  assert.equal(deriveChannel({ referrer: "https://www.bing.com/" }), "organic_search");
  assert.equal(deriveChannel({ referrer: "https://blog.example.com/test" }), "referral_blog.example.com");
  assert.equal(deriveChannel({ referrer: "nicht-mal-eine-url" }), "referral");
});

test("Werte werden entschärft und gekürzt", () => {
  assert.equal(sanitizeTagValue("Sommer Sale 2026 🎉"), "sommer_sale_2026");
  assert.equal(sanitizeTagValue("  --Rand--  "), "--rand--");
  // Sentry kürzt Merkmale selbst NICHT und verbietet Zeilenumbrüche im Wert;
  // Clarity verwirft zu lange Werte still. Also kürzen wir unter allen dreien.
  assert.equal(sanitizeTagValue("x".repeat(400)).length, MAX_VALUE_LENGTH);
  assert.ok(MAX_VALUE_LENGTH <= 200, "muss unter Sentrys 200-Zeichen-Grenze liegen");
  assert.ok(!sanitizeTagValue("erste\nzweite").includes("\n"));
});

test("Bestellwert wird gebändert, nie im Klartext gesetzt", () => {
  assert.equal(valueBand(0), "0_25");
  assert.equal(valueBand(24.99), "0_25");
  assert.equal(valueBand(25), "25_50");
  assert.equal(valueBand(249.5), "100_250");
  assert.equal(valueBand(1000), "1000_plus");
  assert.equal(valueBand(Number.NaN), "unknown");
  assert.equal(valueBand(-5), "unknown");
});

test("Einwilligung wird auf drei filterbare Fälle eingedampft", () => {
  assert.equal(consentTag(null), null);
  assert.equal(consentTag({}), null);
  assert.equal(consentTag({ ad_storage: "granted", analytics_storage: "granted" }), "granted");
  assert.equal(consentTag({ ad_storage: "denied", analytics_storage: "denied" }), "denied");
  assert.equal(consentTag({ ad_storage: "granted", analytics_storage: "denied" }), "partial");
  assert.equal(consentTag({ ad_storage: true, analytics_storage: true }), "granted");
});

test("buildTags kann strukturell nichts Personenbezogenes setzen", () => {
  const tags = buildTags({
    attribution: { gclid: "abc", utm_campaign: "Sommer Sale" },
    consent: { ad_storage: "granted", analytics_storage: "granted" },
    purchaseValue: 240,
  });
  assert.deepEqual(tags, {
    td_channel: "google_paid",
    td_campaign: "sommer_sale",
    td_consent: "granted",
    td_value_band: "100_250",
  });
  const werte = Object.values(tags).join(" ");
  assert.ok(!/\d{3,}/.test(werte.replace(/\d+_\d+/g, "")), "kein Klartext-Betrag im Merkmal");
});

test("alle Schlüssel sind statisch, präfixiert und für alle drei Anbieter zulässig", () => {
  const tags = buildTags({
    attribution: { gclid: "a", utm_campaign: "x" },
    consent: { ad_storage: "granted" },
    purchaseValue: 10,
    attributed: false,
  });
  for (const key of Object.keys(tags)) {
    assert.ok(key.startsWith("td_"), `${key} braucht unser Präfix`);
    // Sentry erlaubt nur a-zA-Z0-9._:- und keine Leerzeichen.
    assert.match(key, /^[a-zA-Z0-9._:-]+$/);
    // PostHog reserviert das führende $.
    assert.ok(!key.startsWith("$"));
    assert.ok(key.length <= 200);
  }
  for (const wert of Object.values(tags)) assert.ok(wert.length <= MAX_VALUE_LENGTH);
});

test("attributed bleibt weg, solange der Server nichts gesagt hat", () => {
  assert.equal(buildTags({}).td_attributed, undefined);
  assert.equal(buildTags({ attributed: false }).td_attributed, "no");
  assert.equal(buildTags({ attributed: true }).td_attributed, "yes");
});
