/**
 * Historische Bestellungen nachträglich einspielen.
 *
 * Zweck ist nicht Vollständigkeit um ihrer selbst willen: Wer heute anfängt,
 * misst ab heute — und kann weder sagen, ob die Werbung letztes Quartal
 * funktioniert hat, noch wie viel das aktuelle Tracking überhaupt erfasst.
 * Der Backfill liefert beides: die Historie und die Erkennungsquote
 * (Bestellungen im Shop ⟷ Events, die angekommen sind).
 *
 * Er ist bewusst hier im SDK und nicht nur im Importer: Kunden ohne
 * WooCommerce/Shopware — ein Fitnessstudio, ein Buchungssystem, ein
 * selbstgebauter Shop — spielen ihre Historie mit demselben Code ein.
 */

import { hashEmail, hashPhone, hashPhoneE164, sha256Hex, normalizeEmail } from "./hash.ts";

export interface BackfillItem {
  id: string;
  name?: string;
  quantity?: number;
  price?: number;
  category?: string;
}

/** Eine historische Bestellung, wie sie im Quellsystem steht — mit Klartext-PII. */
export interface BackfillOrder {
  /** Bestellnummer im Quellsystem. Pflicht — sie macht den Import wiederholbar. */
  order_id: string;
  /** Zeitpunkt der Bestellung (ISO-8601). */
  occurred_at: string;
  value: number;
  currency?: string;
  /** Klartext — wird lokal gehasht und niemals versendet. */
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** ISO-Ländercode, z. B. "DE". */
  country?: string;
  /** Pseudonyme Kundenkennung für plattformübergreifendes Matching. */
  customer_ref?: string;
  tax?: number;
  shipping?: number;
  coupon?: string;
  payment_type?: string;
  items?: BackfillItem[];
  /** Storniert oder rückerstattet — zählt als Korrektur, nicht als Umsatz. */
  is_cancelled?: boolean;
  url?: string;
  gclid?: string;
  fbc?: string;
  fbp?: string;
}

export interface BackfillTransportResult {
  ok: boolean;
  accepted: number;
  failed: number;
  errors: string[];
}

export type BackfillTransport = (
  batch: Record<string, unknown>[],
) => Promise<BackfillTransportResult>;

export interface BackfillOptions {
  shopId: string;
  transport: BackfillTransport;
  batchSize?: number;
  /** Nichts senden, nur vorbereiten und zurückgeben. */
  dryRun?: boolean;
  /** Ländervorwahl ohne +, für Telefonnummern in nationaler Schreibweise. */
  defaultCountry?: string;
  onProgress?: (p: { done: number; total: number; accepted: number; failed: number }) => void;
}

export interface BackfillResult {
  prepared: number;
  accepted: number;
  failed: number;
  errors: string[];
  /** Nur beim Probelauf gefüllt. */
  sample?: Record<string, unknown>[];
}

/**
 * Ableitbare Event-ID. Zweimal importieren darf keine doppelten Conversions
 * erzeugen — deshalb hängt die ID an Shop + Bestellnummer + Typ und nicht an
 * einem Zufallswert. Storno und Kauf derselben Bestellung bleiben getrennt.
 */
export function backfillEventId(shopId: string, orderId: string, type: string): string {
  return `bf_${simpleHash(`${shopId}|${orderId}|${type}`)}`;
}

/** FNV-1a, hex, 16 Zeichen — synchron, deterministisch, ohne WebCrypto-Await. */
function simpleHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

/** Meta verlangt auch Ort, Land, PLZ als Hash — kleingeschrieben, ohne Leerzeichen. */
async function hashPlain(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const norm = value.trim().toLowerCase().replace(/\s+/g, "");
  if (!norm) return undefined;
  return sha256Hex(norm);
}

async function toEvent(
  o: BackfillOrder,
  opts: BackfillOptions,
): Promise<Record<string, unknown>> {
  if (!o.order_id) {
    throw new Error("Bestellung ohne order_id — ohne Kennung ist der Import nicht wiederholbar.");
  }
  const type = o.is_cancelled ? "refund" : "purchase";

  const ev: Record<string, unknown> = {
    event_id: backfillEventId(opts.shopId, o.order_id, type),
    shop_id: opts.shopId,
    type,
    source: "backfill",
    occurred_at: o.occurred_at,
    value: o.value,
    currency: o.currency ?? "EUR",
    order_id: o.order_id,
  };

  if (o.email) ev.em = await hashEmail(o.email);
  if (o.phone) {
    // Zwei Hashes, weil Meta ohne und Google mit Pluszeichen verlangt.
    ev.ph = await hashPhone(o.phone, opts.defaultCountry ?? "49");
    ev.ph_e164 = await hashPhoneE164(o.phone, opts.defaultCountry ?? "49");
  }
  const fn = await hashPlain(o.first_name);
  const ln = await hashPlain(o.last_name);
  const ct = await hashPlain(o.city);
  const st = await hashPlain(o.state);
  const zp = await hashPlain(o.zip);
  const country = await hashPlain(o.country);
  if (fn) ev.fn = fn;
  if (ln) ev.ln = ln;
  if (ct) ev.ct = ct;
  if (st) ev.st = st;
  if (zp) ev.zp = zp;
  if (country) ev.country = country;

  if (o.customer_ref) ev.external_id = o.customer_ref;
  if (o.tax !== undefined) ev.tax = o.tax;
  if (o.shipping !== undefined) ev.shipping = o.shipping;
  if (o.coupon) ev.coupon = o.coupon;
  if (o.payment_type) ev.payment_type = o.payment_type;
  if (o.items?.length) ev.items = o.items;
  if (o.url) ev.url = o.url;
  // Klick-IDs sind nach Monaten meist wertlos, aber wenn das Quellsystem sie
  // hat, gehören sie mit — Google akzeptiert gclid-Uploads bis 90 Tage.
  if (o.gclid) ev.gclid = o.gclid;
  if (o.fbc) ev.fbc = o.fbc;
  if (o.fbp) ev.fbp = o.fbp;

  return ev;
}

export async function backfill(
  orders: BackfillOrder[],
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const batchSize = opts.batchSize ?? 200;
  const events: Record<string, unknown>[] = [];
  for (const o of orders) events.push(await toEvent(o, opts));

  if (opts.dryRun) {
    return { prepared: events.length, accepted: 0, failed: 0, errors: [], sample: events };
  }

  let accepted = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    try {
      const res = await opts.transport(batch);
      accepted += res.accepted;
      failed += res.failed;
      if (res.errors.length) errors.push(...res.errors);
    } catch (e) {
      // Ein kaputter Stapel darf den Rest nicht mitreißen. Wer 40.000
      // Bestellungen importiert, will nicht bei Nummer 12.000 von vorne
      // anfangen — und dank abgeleiteter event_id kostet ein zweiter Lauf
      // nichts außer Zeit.
      failed += batch.length;
      errors.push(`Stapel ${i / batchSize + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
    opts.onProgress?.({
      done: Math.min(i + batchSize, events.length),
      total: events.length,
      accepted,
      failed,
    });
  }

  return { prepared: events.length, accepted, failed, errors };
}

export { normalizeEmail };
