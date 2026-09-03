import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureHashed, hashEmail, hashPhone, normalizeEmail, normalizePhone } from "./hash.ts";
import { newEventId } from "./types.ts";
import { createClient } from "./server.ts";

test("E-Mail wird wie bei Meta/Google normalisiert", () => {
  assert.equal(normalizeEmail("  Kunde@Example.DE "), "kunde@example.de");
});

test("Telefon → E.164 ohne Plus, mit Länder-Default", () => {
  assert.equal(normalizePhone("0176 1234 5678"), "4917612345678");
  assert.equal(normalizePhone("+49 176 12345678"), "4917612345678");
  assert.equal(normalizePhone("0049-176-12345678"), "4917612345678");
  assert.equal(normalizePhone("079 123 45 67", "41"), "41791234567", "CH-Default");
});

test("Hashes sind 64 Hex-Zeichen und stabil", async () => {
  const a = await hashEmail("Kunde@Example.de");
  const b = await hashEmail("kunde@example.de");
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b, "Normalisierung vor dem Hashen");
});

test("ensureHashed reicht fertige Hashes durch", async () => {
  const hash = await hashEmail("test@test.de");
  assert.equal(await ensureHashed(hash, "email"), hash);
  assert.equal(await ensureHashed(hash.toUpperCase(), "email"), hash);
});

test("Event-IDs erfüllen die Mindestlänge des Collectors (8)", () => {
  const id = newEventId();
  assert.ok(id.length >= 8);
  assert.notEqual(newEventId(), newEventId());
});

test("Server-Client hasht Klartext-PII vor dem Senden", async () => {
  let captured: Record<string, unknown> = {};
  const td = createClient({
    endpoint: "https://example.test/collect",
    shopId: "shop_x",
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response("{}", { status: 202 });
    },
  });
  const res = await td.purchase({ value: 89.9, currency: "EUR", email: "Kunde@Example.de", phone: "0176 1234 5678" });

  assert.equal(res.ok, true);
  assert.equal(captured.shop_id, "shop_x");
  assert.equal(captured.type, "purchase");
  assert.match(String(captured.em), /^[a-f0-9]{64}$/);
  assert.match(String(captured.ph), /^[a-f0-9]{64}$/);
  assert.equal("email" in captured, false, "Klartext darf das Haus nicht verlassen");
  assert.equal("phone" in captured, false);
});

test("Server-Client wiederholt bei 5xx, nicht bei 4xx", async () => {
  let calls = 0;
  const td5 = createClient({
    endpoint: "https://example.test/collect",
    retries: 2,
    fetchImpl: async () => {
      calls++;
      return new Response("boom", { status: 500 });
    },
  });
  await td5.lead("probetraining");
  assert.equal(calls, 3, "1 Versuch + 2 Wiederholungen");

  calls = 0;
  const td4 = createClient({
    endpoint: "https://example.test/collect",
    retries: 2,
    fetchImpl: async () => {
      calls++;
      return new Response("nope", { status: 400 });
    },
  });
  const res = await td4.lead("probetraining");
  assert.equal(calls, 1, "4xx wird nicht wiederholt");
  assert.equal(res.ok, false);
});

test("event_id bleibt erhalten (Dedup Browser ↔ Server)", async () => {
  let captured: Record<string, unknown> = {};
  const td = createClient({
    endpoint: "https://example.test/collect",
    fetchImpl: async (_u, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response("{}", { status: 202 });
    },
  });
  const shared = newEventId("order");
  const res = await td.purchase({ event_id: shared, value: 10 });
  assert.equal(captured.event_id, shared);
  assert.equal(res.event_id, shared);
});

test("Server-SDK: environment wandert in jedes Event; ohne Angabe fehlt es (Collector füllt production)", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  }) as typeof fetch;

  const { createClient } = await import("./server.ts");
  const staging = createClient({
    endpoint: "https://td.test/collect", shopId: "s1",
    environment: "staging", fetchImpl,
  });
  await staging.track({ type: "purchase", event_id: "evt_12345678", value: 1 });
  assert.equal(sent[0]?.environment, "staging");

  const ohne = createClient({ endpoint: "https://td.test/collect", shopId: "s1", fetchImpl });
  await ohne.track({ type: "purchase", event_id: "evt_12345679", value: 1 });
  // Bewusst NICHT clientseitig „production“ setzen: Der Collector füllt den
  // Standard — eine zweite Quelle der Wahrheit würde nur auseinanderlaufen.
  assert.equal("environment" in (sent[1] ?? {}), false);
});
