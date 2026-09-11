/** Die vom Collector akzeptierten Event-Typen. */
/**
 * Alle Ereignisarten, die der Collector annimmt.
 *
 * Als Liste und nicht nur als Typ, damit ein Aufrufer sie zur Laufzeit prüfen
 * kann — und damit der Wächtertest sie mit `EVENT_TYPES` aus
 * `@trackdolphin/event-schema` vergleichen kann. Das SDK hat bewusst KEINE
 * Abhängigkeiten (es geht in fremde Browser), also muss die Liste hier
 * doppelt stehen; der Test sorgt dafür, dass die beiden nicht auseinander
 * laufen. Ein SDK, das einen gültigen Typ nicht kennt, macht ihn für jeden
 * Kunden unerreichbar, ohne dass irgendwo ein Fehler entsteht.
 */
export const EVENT_TYPES = [
  // Handel
  "view_item",
  "view_item_list",
  "add_to_cart",
  "remove_from_cart",
  "view_cart",
  "begin_checkout",
  "add_payment_info",
  "purchase",
  /** Storno/Rückerstattung — korrigiert den Umsatz, erhöht ihn nicht. */
  "refund",
  // Leadgenerierung
  "page_view",
  "search",
  "lead",
  "sign_up",
  /** Termin gebucht (Probetraining, Beratung, Rückruf) — bei Meta: Schedule. */
  "schedule",
  "subscribe",
  "contact",
  // Ausgänge: was aus einem Vorgang geworden ist
  /** Bestellung freigegeben, Lead ist echt, Anmeldung bestätigt. */
  "qualified",
  /** Storno vor Versand, Lead abgesprungen, Termin abgesagt. */
  "cancel",
  /** Nicht erschienen, nicht erreicht. */
  "no_show",
  // Trichter-Schritte innerhalb eines Formulars. Sie verlassen Trackdolphin
  // nie und beantworten nur „wo brechen Leute ab?".
  "form_viewed",
  "form_started",
  "field_focused",
  "form_validation_error",
  "form_submitted",
  "success_shown",
  "confirmed_double_optin",
  "custom",
  /** Wird von `identify()` gesendet — trägt `traits` und die Match-Hashes. */
  "identify",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Consent Mode v2 — die vier Google-Signale, wie sie auch der Tag Manager
 * kennt. Das SDK schickt den Zustand mit jedem Event; die Plattformen
 * entscheiden damit selbst, was sie verwenden dürfen.
 */
export type ConsentValue = "granted" | "denied";

/**
 * Woher der Zustand stammt. Dieselbe Liste wie `CONSENT_SOURCES` im
 * Event-Schema; der Wächtertest in event-typen.test.ts hält beide gleich.
 *
 * `cmp`: ein Consent-Werkzeug im Browser hat ihn geliefert. `api`: die
 * Anwendung hat `setConsent()` selbst gerufen. `default`: niemand hat je
 * entschieden. Ohne diesen Schlüssel sah eine Voreinstellung
 * (`gtag('consent','default',{ad_storage:'granted'})`) auf dem Server genauso
 * aus wie eine Zustimmung, und der Kunde wähnte sich konform.
 */
export const CONSENT_SOURCES = ["cmp", "default", "api"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export interface ConsentState {
  ad_storage?: ConsentValue;
  analytics_storage?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
  /** Füllt das SDK selbst; wer es an `setConsent()` mitgibt, überschreibt die Herkunft. */
  source?: ConsentSource;
  /** Name des erkannten Consent-Werkzeugs, leer wenn keins (siehe cmp.ts). */
  cmp?: string;
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
  /**
   * Vor- und Nachname als SHA-256 über den normalisierten Wert — Match-Signale
   * für Google Enhanced Conversions, Meta Advanced Matching und die übrigen
   * Plattformen. Im Browser füllt `identify({ firstName, lastName })` sie;
   * serverseitig hasht der Absender selbst (siehe `hashName` in ./hash.ts, das
   * ist die Normalisierung, die alle Plattformen mittragen).
   */
  fn?: string;
  ln?: string;
  /** Einwilligungsstand nach Consent Mode v2; im Browser füllt ihn `setConsent()`. */
  consent?: ConsentState;
  /**
   * Stabile pseudonyme Kundenkennung (z. B. die Kundennummer). Im Browser
   * setzt `identify()` sie automatisch; in der App bilden sich daraus Kohorten.
   */
  external_id?: string;
  /** Nur bei type: "identify" — Eigenschaften der Person. */
  traits?: Traits;
  /**
   * Die Kontaktliste des Besuchers (utm, Klick-Art, Referrer je Besuch).
   * Im Browser füllt das SDK sie aus dem Cookie `_td_touch`; wer sie
   * selbst setzt, überschreibt das. Form: `Touchpoint` aus ./attribution.ts.
   */
  touches?: import("./attribution.ts").Touchpoint[];
  /** Sitzungskennung; im Browser vergibt das SDK sie selbst (30 Minuten Stille = neue Sitzung). */
  session_id?: string;
  /**
   * Eigenschaften dieses VORGANGS: Standort, Tarif, Telefonland,
   * Landingpage-Variante. Anders als `traits` bei jeder Ereignisart erlaubt.
   *
   * Der Unterschied ist keine Formsache: `traits` beschreiben, wer jemand
   * IST, `properties`, was bei diesem einen Vorgang galt. Dieselbe Person
   * kann in Hamburg und in Mainz buchen — ein Standort an der Person wäre
   * schon beim zweiten Termin falsch, und niemand merkt es.
   *
   * Flach und höchstens 20 Schlüssel, Werte bis 256 Zeichen; verschachtelte
   * Objekte weist der Collector ab, weil sie in einer Segmentierung nicht
   * vergleichbar wären. Auswerten lässt sich das über `getProjectSegments`.
   */
  properties?: Traits;
  /**
   * Die Klammer eines Vorgangs über mehrere Ereignisse hinweg: derselbe Wert
   * bei `lead`, `qualified`, `schedule`, `purchase` und `cancel` heisst „das
   * gehört zusammen".
   *
   * Ohne sie ist die Klammer die Person, und das reicht nicht: Wer zweimal
   * ein Probetraining bucht, hat zwei Ketten, und hinterher lässt sich nicht
   * sagen, welcher Termin abgesagt wurde und welcher zum Vertrag führte.
   */
  object_id?: string;
  /**
   * Klartext für die Personenansicht — die einzigen Felder, die der Collector
   * lesbar annimmt (`em`/`ph`/`fn`/`ln` weiterhin nur als SHA-256). Im Browser
   * füllt `identify({ email, name, firstName, lastName })` sie; sie verlassen
   * die Seite nur nach einer ausdrücklichen Einwilligung mit
   * Speicher-Erlaubnis. Serverseitig entscheidet der Absender selbst — dort
   * gibt es keinen Browser, der eine Einwilligung kennen könnte.
   *
   * `contact_name` ist der ganze Name, `contact_first_name`/`contact_last_name`
   * sind die Bestandteile. Wer nur den ganzen Namen hat, schickt nur ihn: Wir
   * zerlegen hier nichts, weil sich „van der Berg" nicht zuverlässig teilen
   * lässt.
   */
  contact_email?: string;
  contact_name?: string;
  contact_first_name?: string;
  contact_last_name?: string;
  /** Klick-IDs; im Browser füllt das SDK sie selbst aus der Attribution. */
  gclid?: string;
  gbraid?: string;
  /** TikTok-Klick-Kennung aus `?ttclid=`. */
  ttclid?: string;
  /** Microsoft-Klick-Kennung aus `?msclkid=` — ohne sie kein Offline-Upload. */
  msclkid?: string;
  /** Pinterest-Klick-Kennung aus `?epik=` bzw. dem `_epik`-Cookie. */
  epik?: string;
  /**
   * OpenAI-/ChatGPT-Ads-Klick-Kennung aus `?oppref=` bzw. dem Cookie
   * `__oppref` (zwei Unterstriche!). Sie wird unverändert weitergereicht —
   * OpenAI verlangt ausdrücklich den Originaltext, kein Trimmen, kein Hashen.
   */
  oppref?: string;
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
