import { test } from "node:test";
import assert from "node:assert/strict";
import { backfill, backfillEventId, type BackfillOrder } from "./backfill.ts";

const order = (over: Partial<BackfillOrder> = {}): BackfillOrder => ({
  order_id: "1042",
  occurred_at: "2026-03-14T10:22:00.000Z",
  value: 119.9,
  currency: "EUR",
  email: "Kunde@Example.de",
  ...over,
});

/** Sammelt, was rausgegangen wäre. */
function recorder() {
  const sent: any[] = [];
  return {
    sent,
    transport: async (batch: any[]) => {
      sent.push(...batch);
      return { ok: true, accepted: batch.length, failed: 0 as number, errors: [] as string[] };
    },
  };
}

test("hasht E-Mail und Telefon lokal — Klartext verlässt den Prozess nie", async () => {
  const r = recorder();
  await backfill([order({ phone: "0170 1234567" })], { shopId: "s1", transport: r.transport });

  const raw = JSON.stringify(r.sent);
  assert.equal(raw.includes("Kunde@Example.de"), false, "E-Mail im Klartext versendet");
  assert.equal(raw.includes("01701234567"), false, "Telefon im Klartext versendet");
  assert.match(r.sent[0].em, /^[a-f0-9]{64}$/);
  assert.match(r.sent[0].ph, /^[a-f0-9]{64}$/);
  assert.equal("email" in r.sent[0], false, "Rohfeld email mitgesendet");
});

test("event_id ist aus der Bestellung abgeleitet — zweiter Lauf erzeugt keine Dubletten", async () => {
  const a = recorder();
  const b = recorder();
  await backfill([order()], { shopId: "s1", transport: a.transport });
  await backfill([order()], { shopId: "s1", transport: b.transport });
  assert.equal(a.sent[0].event_id, b.sent[0].event_id);

  // Anderer Shop, gleiche Bestellnummer → anderes Event.
  const c = recorder();
  await backfill([order()], { shopId: "s2", transport: c.transport });
  assert.notEqual(a.sent[0].event_id, c.sent[0].event_id);
});

test("benutzt den Bestellzeitpunkt, nicht den Importzeitpunkt", async () => {
  const r = recorder();
  await backfill([order()], { shopId: "s1", transport: r.transport });
  assert.equal(r.sent[0].occurred_at, "2026-03-14T10:22:00.000Z");
  assert.equal(r.sent[0].source, "backfill");
});

test("teilt große Mengen in Stapel und meldet den Fortschritt", async () => {
  const batches: number[] = [];
  const progress: { done: number; total: number }[] = [];
  const orders = Array.from({ length: 250 }, (_, i) => order({ order_id: `o${i}` }));

  const res = await backfill(orders, {
    shopId: "s1",
    batchSize: 100,
    onProgress: (p) => progress.push({ ...p }),
    transport: async (b) => {
      batches.push(b.length);
      return { ok: true, accepted: b.length, failed: 0, errors: [] };
    },
  });

  assert.deepEqual(batches, [100, 100, 50]);
  assert.equal(res.accepted, 250);
  assert.equal(progress.at(-1)?.done, 250);
  assert.equal(progress.at(-1)?.total, 250);
});

test("ein kaputter Stapel stoppt den Import nicht — er wird berichtet", async () => {
  let n = 0;
  const res = await backfill(
    Array.from({ length: 30 }, (_, i) => order({ order_id: `o${i}` })),
    {
      shopId: "s1",
      batchSize: 10,
      transport: async (b) => {
        n++;
        if (n === 2) throw new Error("HTTP 502");
        return { ok: true, accepted: b.length, failed: 0, errors: [] };
      },
    },
  );
  assert.equal(res.accepted, 20);
  assert.equal(res.failed, 10);
  assert.match(res.errors.join(" "), /502/);
  assert.equal(n, 3, "nach dem Fehler wurde abgebrochen statt weitergemacht");
});

test("Probelauf sendet nichts, rechnet aber alles durch", async () => {
  const r = recorder();
  const res = await backfill([order(), order({ order_id: "1043" })], {
    shopId: "s1", dryRun: true, transport: r.transport,
  });
  assert.equal(r.sent.length, 0);
  assert.equal(res.prepared, 2);
  assert.equal(res.accepted, 0);
  assert.equal(res.sample?.length, 2, "Probelauf soll die Events zum Prüfen zurückgeben");
  assert.match(String(res.sample?.[0]?.em), /^[a-f0-9]{64}$/);
});

test("Stornos werden als Storno markiert statt als Umsatz gezählt", async () => {
  const r = recorder();
  await backfill([order({ is_cancelled: true })], { shopId: "s1", transport: r.transport });
  assert.equal(r.sent[0].type, "refund");
  assert.equal(r.sent[0].value, 119.9);
  assert.notEqual(backfillEventId("s1", "1042", "refund"), backfillEventId("s1", "1042", "purchase"));
});

test("Bestellungen ohne Kennung werden abgewiesen, nicht still verschluckt", async () => {
  const r = recorder();
  await assert.rejects(
    () => backfill([order({ order_id: "" })], { shopId: "s1", transport: r.transport }),
    /order_id/,
  );
});

test("übernimmt Land, Steuer, Versand, Gutschein und Positionen", async () => {
  const r = recorder();
  await backfill(
    [order({
      country: "DE", tax: 19.14, shipping: 4.9, coupon: "SOMMER10", payment_type: "paypal",
      customer_ref: "cust_9f2a",
      items: [{ id: "SKU-1", name: "Hantel", quantity: 2, price: 49.95, category: "Kraft" }],
    })],
    { shopId: "s1", transport: r.transport },
  );
  const e = r.sent[0];
  assert.match(e.country, /^[a-f0-9]{64}$/, "Land muss gehasht sein (Meta-Vorgabe)");
  assert.equal(e.tax, 19.14);
  assert.equal(e.shipping, 4.9);
  assert.equal(e.coupon, "SOMMER10");
  assert.equal(e.payment_type, "paypal");
  assert.equal(e.external_id, "cust_9f2a");
  assert.equal(e.items[0].id, "SKU-1");
  assert.equal(e.order_id, "1042");
});
