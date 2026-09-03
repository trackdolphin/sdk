/** Die vom Collector akzeptierten Event-Typen. */
export type EventType =
  | "view_item"
  | "view_item_list"
  | "add_to_cart"
  | "remove_from_cart"
  | "begin_checkout"
  | "add_payment_info"
  | "purchase"
  | "custom"
  /** Wird von `identify()` gesendet — trägt `traits` und die Match-Hashes. */
  | "identify";

/**
 * Consent Mode v2 — die vier Google-Signale, wie sie auch der Tag Manager
 * kennt. Das SDK schickt den Zustand mit jedem Event; die Plattformen
 * entscheiden damit selbst, was sie verwenden dürfen.
 */
export type ConsentValue = "granted" | "denied";

export interface ConsentState {
  ad_storage?: ConsentValue;
  analytics_storage?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
}

/** Eigenschaften einer Person für `identify()` — nur flache Werte. */
export type Traits = Record<string, string | number | boolean>;

export interface EventItem {
  id: string;
  name?: string;
  quantity?: number;
  price?: number;
  category?: string;
}

export interface TrackEvent {
  /** Eindeutig je Vorgang, mind. 8 Zeichen. Fehlt sie, erzeugt das SDK eine. */
  event_id?: string;
  type: EventType;
  /** Nur bei type: "custom" — der eigene Event-Name. */
  custom_name?: string;
  value?: number;
  currency?: string;
  items?: EventItem[];
  url?: string;
  referrer?: string;
  occurred_at?: string;
  /** Klartext erlaubt — das SDK hasht vor dem Senden. */
  email?: string;
  phone?: string;
  /** Bereits gehashte Werte (falls die Anwendung selbst hasht). */
  em?: string;
  ph?: string;
  /** Telefon-Hash MIT Plus (Google-Format); wird aus `phone` automatisch gebildet. */
  ph_e164?: string;
  /** Einwilligungsstand nach Consent Mode v2; im Browser füllt ihn `setConsent()`. */
  consent?: ConsentState;
  /**
   * Stabile pseudonyme Kundenkennung (z. B. die Kundennummer). Im Browser
   * setzt `identify()` sie automatisch; in der App bilden sich daraus Kohorten.
   */
  external_id?: string;
  /** Nur bei type: "identify" — Eigenschaften der Person. */
  traits?: Traits;
  /** Klick-IDs; im Browser füllt das SDK sie selbst aus der Attribution. */
  gclid?: string;
  gbraid?: string;
  /** TikTok-Klick-Kennung aus `?ttclid=`. */
  ttclid?: string;
  /** Microsoft-Klick-Kennung aus `?msclkid=` — ohne sie kein Offline-Upload. */
  msclkid?: string;
  /** Pinterest-Klick-Kennung aus `?epik=` bzw. dem `_epik`-Cookie. */
  epik?: string;
  wbraid?: string;
  fbc?: string;
  fbp?: string;
  ga_client_id?: string;
  /** Wird im Browser automatisch gesetzt; serverseitig optional mitgeben,
   *  um ein Server-Event derselben Person zuzuordnen. */
  visitor_id?: string;
}

/** Erzeugt eine Event-ID, die Browser und Server teilen können (Dedup!). */
export function newEventId(prefix = "evt"): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 16)
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${rand}`;
}
