/**
 * Trackdolphin Server-SDK (Node, Edge, Worker).
 *
 *   import { createClient } from "@trackdolphin/sdk/server";
 *   const td = createClient({ endpoint: process.env.TD_ENDPOINT! });
 *   await td.purchase({ event_id: orderEventId, value: 89.9, currency: "EUR",
 *                       email: order.email, phone: order.phone, gclid });
 *
 * Serverseitige Events sind die verlässlichen: Der Bestellwert kommt aus der
 * Bestellung, nicht aus einem gescrapten DataLayer — und sie kommen an, auch
 * wenn im Browser nichts feuert.
 */
import { ensureHashed, hashPhone, hashPhoneE164 } from "./hash.ts";
import { newEventId, type TrackEvent } from "./types.ts";

export * from "./types.ts";
export * from "./hash.ts";
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

export interface ServerClientOptions {
  /** Collector-URL aus der Einrichtungs-Seite. */
  endpoint: string;
  /** Nur nötig, wenn nicht an den shop-eigenen Host gesendet wird. */
  shopId?: string;
  /** Standard-Ländervorwahl für Telefonnummern ohne Präfix. */
  defaultCountry?: string;
  /**
   * Umgebung dieses Clients (z. B. „staging“). Wird jedem Event mitgegeben.
   * Ohne Angabe bleibt das Feld weg — der Collector füllt „production“;
   * eine zweite Quelle der Wahrheit hier würde nur auseinanderlaufen.
   */
  environment?: string;
  /** Wie oft bei Netzwerk-/5xx-Fehlern erneut versucht wird. */
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SendResult {
  ok: boolean;
  status: number;
  event_id: string;
  error?: string;
}

export function createClient(opts: ServerClientOptions) {
  const {
    endpoint,
    shopId,
    defaultCountry = "49",
    retries = 2,
    timeoutMs = 5000,
    fetchImpl = fetch,
  } = opts;

  /**
   * Hashen, das höchstens das eigene Feld kostet. Ein Event ohne `em` matcht
   * schlechter; ein geworfener Fehler stünde dagegen mitten in der
   * Bestellstrecke des Aufrufers.
   */
  async function safeHash(hash: () => Promise<string>): Promise<string | undefined> {
    try {
      return await hash();
    } catch (e) {
      console.warn("[trackdolphin] Hashing übersprungen:", e);
      return undefined;
    }
  }

  async function send(ev: TrackEvent): Promise<SendResult> {
    const eventId = ev.event_id ?? newEventId();
    let body: string;
    try {
      body = await buildBody(ev, eventId);
    } catch (e) {
      // Diese Funktion lehnt nie ab — der Aufrufer sieht einen Fehlschlag im
      // Ergebnis, nicht als Ausnahme in seinem Bestell-Code.
      return { ok: false, status: 0, event_id: eventId, error: String(e) };
    }
    return sendBody(body, eventId);
  }

  async function buildBody(ev: TrackEvent, eventId: string): Promise<string> {
    const payload: Record<string, unknown> = {
      ...ev,
      event_id: eventId,
      occurred_at: ev.occurred_at ?? new Date().toISOString(),
    };
    if (shopId) payload.shop_id = shopId;
    if (opts.environment) payload.environment = opts.environment;

    // Klartext hier hashen — der Collector nimmt nur SHA-256 an.
    if (ev.email) payload.em = await safeHash(() => ensureHashed(ev.email!, "email"));
    if (ev.phone) {
      // Zwei Hashes: Meta verlangt die Nummer ohne, Google mit Pluszeichen.
      payload.ph = await safeHash(() => hashPhone(ev.phone!, defaultCountry));
      payload.ph_e164 = await safeHash(() => hashPhoneE164(ev.phone!, defaultCountry));
    }
    delete payload.email;
    delete payload.phone;
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];
    return JSON.stringify(payload);
  }

  async function sendBody(body: string, eventId: string): Promise<SendResult> {
    let lastError = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        // 4xx sind Anwendungsfehler — die behebt kein Neuversuch.
        if (res.ok || (res.status >= 400 && res.status < 500)) {
          return {
            ok: res.ok,
            status: res.status,
            event_id: eventId,
            error: res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 300),
          };
        }
        lastError = `HTTP ${res.status}`;
      } catch (e) {
        lastError = String(e);
      }
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 2 ** attempt * 250));
      }
    }
    return { ok: false, status: 0, event_id: eventId, error: lastError };
  }

  return {
    /** Beliebiges Event senden. */
    track: send,

    /** Kauf — mit der event_id aus dem Browser deduplizieren! */
    purchase: (ev: Omit<TrackEvent, "type">) => send({ ...ev, type: "purchase" }),

    /** Lead/Custom-Event (Leadgen: Probetraining, Kontaktformular, …). */
    lead: (name: string, ev: Omit<TrackEvent, "type" | "custom_name"> = {}) =>
      send({ ...ev, type: "custom", custom_name: name }),

    /** Mehrere Events nacheinander (der Collector dedupliziert je event_id). */
    async trackMany(events: TrackEvent[]): Promise<SendResult[]> {
      const out: SendResult[] = [];
      for (const ev of events) out.push(await send(ev));
      return out;
    },

    /** Teilbare Event-ID erzeugen (Browser + Server benutzen dieselbe). */
    newEventId,
  };
}

export type TrackdolphinClient = ReturnType<typeof createClient>;
