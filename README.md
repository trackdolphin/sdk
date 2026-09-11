# @trackdolphin/sdk

Events aus Browser und Server an [Trackdolphin](https://trackdolphin.com) senden —
für Shops und Anwendungen ohne fertiges Plugin. Ein Paket, drei Einstiege:
`@trackdolphin/sdk` (Browser), `@trackdolphin/sdk/proxy` (die Route, über die der
Browser sendet) und `@trackdolphin/sdk/server` (Node, Edge, Worker).

Vollständige Doku: <https://trackdolphin.com/docs/sdk>

## Installation

```bash
npm install @trackdolphin/sdk
```

## Die Proxy-Route (empfohlen)

Der Browser spricht nur mit deiner Domain, dein Server spricht mit dem
Collector. Werbeblocker sehen keinen fremden Hostnamen; Safari lässt das
Besucher-Cookie leben, weil dein Server es per `Set-Cookie` setzt (ein
JS-Cookie kappt es nach sieben Tagen). `createCollectProxy` ist ein Handler
über Web-Standard `Request`/`Response` — ohne Node-Abhängigkeiten, lauffähig
auf Node, Cloudflare Workers und Vercel Edge.

```ts
// SvelteKit: src/routes/td/+server.ts
import { createCollectProxy } from "@trackdolphin/sdk/proxy";
const proxy = createCollectProxy({ endpoint: process.env.TD_ENDPOINT! });
export const POST = ({ request }) => proxy(request);
export const OPTIONS = POST;

// Next.js (App Router): app/td/route.ts
export const POST = createCollectProxy({ endpoint: process.env.TD_ENDPOINT! });

// Nuxt (h3 v1): server/api/td.post.ts
export default defineEventHandler(async (event) =>
  sendWebResponse(event, await proxy(toWebRequest(event))));

// Astro: src/pages/td.ts          Remix: app/routes/td.ts
export const POST: APIRoute = ({ request }) => proxy(request);
export const action = ({ request }) => proxy(request);
```

Der Handler nimmt nur `POST` bis 64 KB an, ergänzt `client_ip` und
`client_user_agent`, reicht Tracking-Cookies über eine Positivliste weiter
(`_td_vid`, `_td_attr`, `_td_touch`, `_fbp`, `_fbc`, `_ga`, `_gcl_aw`, `_gcl_au`), setzt
`_td_vid` als Server-Cookie (90 Tage) und antwortet dem Browser mit `204`
oder `202` — Fehler gehen an `log`, nie an den Besucher. Optionen:
`shopId`, `visitorCookie: { requireConsent, maxAgeDays }`, `maxBodyBytes`,
`timeoutMs`, `fetchImpl`, `log`.

## Im Browser

```js
import { init, track, setConsent } from "@trackdolphin/sdk";

// Relativ → Proxy-Route. Die Besucherkennung vergibt die Route, das SDK liest sie nur.
init({ endpoint: "/td", modus: "nach_einwilligung" });

// Aus dem Cookie-Banner — boolean oder granular nach Consent Mode v2:
setConsent({ ad_storage: "granted", analytics_storage: "granted",
             ad_user_data: "granted", ad_personalization: "denied" });

track({ type: "view_item", items: [{ id: "SKU-1", name: "Laufschuh", price: 119.9 }] });
```

### Die drei Modi (ab 0.4.0) — BREAKING

Was vor einer Entscheidung passiert, ist ab 0.4.0 ein Modus statt eines
Schalters (siehe `docs/drei-modi.md`):

| Modus | Vor der Entscheidung |
| --- | --- |
| `nach_einwilligung` | Die Seite schweigt. Kein Ereignis, kein Cookie, kein Speicher; Ereignisse warten im Arbeitsspeicher und gehen nach dem Ja hinaus. |
| `sammeln` | Alles geht mit, was ohne Zugriff aufs Endgerät bekannt ist: Adresse samt Parametern, Referrer, Produkte, Wert. Auf dem Gerät passiert nichts, deshalb keine Besucherkennung und keine Sitzung. |
| `immer` | Sofort mit Kennungen, Cookie gesetzt. |

`sammeln` ist kein Sparmodus: Der Unterschied zu `immer` ist der Zugriff aufs
Endgerät, nicht die Datenmenge. Die `gclid` steht in der Adresse und geht
deshalb mit; `_fbp` und die GA-Client-ID stehen nur in Cookies und fehlen
dort. Das Tor zu Google und Meta sitzt hinter dem Collector, nicht im
Browser.

**Was sich ändert:** Bis 0.3.x sendete das SDK ohne `requireConsent` sofort
und mit Kennungen. Die Vorgabe ist jetzt `nach_einwilligung`. Wer etwas
anderes will, sagt es ausdrücklich:

```js
init({ endpoint: "/td", modus: "immer" });    // wie bis 0.3.x
init({ endpoint: "/td", modus: "sammeln" });  // messen, ohne das Gerät anzufassen
```

`requireConsent` bleibt als Kurzform gültig: `true` ist `nach_einwilligung`,
ein ausdrückliches `false` ist `immer`.

Ohne `modus` fragt das SDK den Collector (`<endpoint>/consent-banner`) — nur
der kennt das Land der Besucherin und die Regel, die im Dashboard dafür
steht. Bis die Antwort da ist, schweigt die Seite. Eine Entscheidung der
Besucherin schlägt den Modus immer.

### Der Consent-Mode-Default (ab 0.4.0)

`init()` sagt Google als Erstes an, was gilt: alle vier Signale `denied` mit
`wait_for_update: 500`, im Modus `immer` alle `granted`. Ohne diese Ansage
verhält sich ein Google-Tag wie eingewilligt und setzt Cookies; im EWR wertet
Google fehlende Signale umgekehrt als nicht eingewilligt und nutzt die Daten
gar nicht.

Der Aufruf gehört so früh wie möglich, VOR dem Google-Tag der Seite. Das SDK
sagt nichts an, wenn schon jemand einen Default angesagt hat oder ein fremdes
Consent-Werkzeug im Fenster steht; mit `consentDefault: false` gar nicht, mit
`consentDefault: true` in jedem Fall.

Ein Modus, der erst aus der Antwort des Collectors kommt, prägt den Default
NICHT mehr — das Google-Tag hat ihn dann womöglich schon gelesen. Wer in
`immer` misst, nennt den Modus deshalb beim `init()`.

### Consent-Werkzeug und Herkunft (ab 0.2.1)

Das SDK erkennt passiv, welches Consent-Werkzeug auf der Seite läuft
(Cookiebot, Usercentrics, Borlabs, Complianz, Real Cookie Banner,
consentmanager, Klaro, jedes TCF-2-Werkzeug, Shopify Customer Privacy, Google
Consent Mode) und trägt zwei Zusatzschlüssel in `consent` ein:

- `cmp`: der Name des Werkzeugs, leer wenn keins.
- `source`: woher der Zustand stammt. `api` heisst „`setConsent()` wurde
  gerufen", `cmp` heisst „das Werkzeug hat entschieden" (Cookiebot, TCF,
  Usercentrics, Klaro, Shopify und ein Consent-Mode-`update` liefern den Zustand
  direkt, `setConsent()` ist dann nicht nötig), `default` heisst „niemand hat
  entschieden". Ein `gtag('consent','default',…)` ist eine Voreinstellung und
  wird als `default` gemeldet, nicht als Zustimmung.

Ohne Werkzeug und ohne `setConsent()` steht am Ereignis nur
`{ source: "default", cmp: "" }`. Das SDK erfindet kein „granted". Die
Tracking-Gesundheit im Dashboard meldet, wenn ein Werkzeug erkannt ist, aber
nie ein Zustimmungssignal ankommt.

Ohne Server-Route geht auch die direkte Collector-URL
(`init({ endpoint: "https://abc123.trdph.com/collect" })`) — dann setzt das SDK
das Besucher-Cookie selbst, und Werbeblocker sowie Safari holen sich ihren
Anteil. Mit `fallbackEndpoint` weicht das SDK für die Sitzung dorthin aus,
falls die Proxy-Route einmal nicht antwortet.

Das SDK erfasst die **Kontaktliste** des Besuchers (bis zu zehn Besuche mit
utm_*, Art der Klick-ID, Referrer-Host und Einstiegsseite, 90 Tage, Cookie
`_td_touch`) und schickt sie mit jedem Event als `touches`; daneben den
ersten Kontakt in `_td_attr` und die Klick-IDs selbst (`gclid`, `fbclid`,
`ttclid`, …). Aus der Liste rechnet Trackdolphin jedes Attributionsmodell
zur Abfragezeit — erster, letzter, letzter bezahlter Kontakt, linear,
positionsbasiert, zeitlicher Zerfall (`getProjectChannelPerformance`).
Ein Direktbesuch überschreibt dabei keine Kampagne. Dazu vergibt das SDK eine
Sitzungskennung (`session_id`, 30 Minuten Stille = neue Sitzung), hasht
E-Mail und Telefon lokal (SHA-256) und puffert Events, solange der Modus
`nach_einwilligung` gilt und niemand zugestimmt hat.

## Trackdolphin Consent: the project's own banner (from 0.3.0)

```js
init({ endpoint: "/td", shopId: "…", requireConsent: true, consent: true });
```

With `consent: true` the SDK fetches the banner the project published in the
dashboard (Consent → Banner) from `<endpoint>/consent-banner`, puts it into
`window.__tdConsentConfig` and loads the runtime from
`https://trackdolphin.com/consent/td-consent.js` (or `consent: { runtimeUrl }`
to serve it from your own domain). The banner renders in the project's
branding, writes Consent Mode v2 (`gtag('consent','update')`), the WP Consent
API and the `_td_consent` cookie, and exposes `window.TrackdolphinConsent`.
The SDK recognises it as the tool `trackdolphin`, so `requireConsent` releases
the queue as soon as the visitor decides. Every decision is relayed to
`<endpoint>/consent` as a consent record (at most a hash of the visitor id).
Without a published version nothing is loaded.

When `endpoint` is your proxy route, the route must accept the two sub-paths
(`/td/consent-banner` and `/td/consent`), e.g. `app/td/[...path]/route.ts` in
Next.js; `createCollectProxy` answers them itself.

## Kauf mit event_id — Browser und Server dedupliziert

```js
import { purchase } from "@trackdolphin/sdk";

// Aus der Bestellnummer abgeleitet, nicht gewürfelt — so ist der Versand wiederholbar.
purchase({ event_id: `order_${order.id}`, value: 89.9, currency: "EUR" });
```

```ts
import { createClient } from "@trackdolphin/sdk/server";

const td = createClient({ endpoint: process.env.TD_ENDPOINT! });
await td.purchase({
  event_id: `order_${order.id}`, // dieselbe ID wie im Browser
  value: 89.9,
  currency: "EUR",
  email: order.email,             // wird lokal gehasht, verlässt den Server nie im Klartext
  phone: order.phone,
});
```

## Personen erkennen

```js
import { identify, reset } from "@trackdolphin/sdk";

await identify({
  email: user.email,
  firstName: user.firstName,
  lastName: user.lastName,
  externalId: user.id,
  traits: { plan: "pro" },
});
// … ab jetzt trägt jedes Event em/ph/fn/ln/external_id; beim Logout:
reset();
```

Dauerhaft gespeichert (localStorage `_td_id`) werden nur Hashes und `externalId` —
nie Klartext.

### Vor- und Nachname (ab 0.5.0)

`firstName` und `lastName` sind neu und rein additiv — bestehende Aufrufe mit `name`
bleiben gültig. `name` ist der GANZE Name; fehlt er, bilden wir ihn aus `firstName`
und `lastName`. Umgekehrt zerlegen wir nichts: „van der Berg" und „Maria Anna"
liessen sich nicht zuverlässig schneiden, und ein falsch geteilter Name fällt
niemandem auf.

Aus `firstName`/`lastName` entstehen die Match-Signale `fn`/`ln` (SHA-256). Die
Normalisierung davor ist die, die alle Plattformen mittragen: Unicode-NFC,
Kleinschreibung, Trimmen und Mehrfach-Leerzeichen auf eines, Ziffern raus, Titel und
Namenszusätze („Dr.", „Jr.") raus. **Umlaute und Akzente bleiben** — Meta zeigt
„Valéry" → „valéry", Google sagt „Accents are allowed"; eine Umschrift ä→ae wäre bei
beiden falsch. Satzzeichen bleiben ebenfalls; die Anbieter widersprechen sich dort,
die Begründung steht in `src/hash.ts`.

`name`, `firstName`, `lastName` und `email` gehen zusätzlich im Klartext mit, aber nur
am `identify`-Ereignis und nur, wenn `setConsent()` eine Einwilligung mit
Speicher-Erlaubnis gesetzt hat. Ohne diese Entscheidung bleibt der Klartext im
Browser; die Hashes gehen wie bisher raus. Er landet in den Feldern
`contact_email`/`contact_name`/`contact_first_name`/`contact_last_name`, dient allein
der Personenansicht im Dashboard und geht an keine Werbeplattform. `reset()` vergisst
ihn mit.

## Clarity, PostHog und Sentry beschriften

Laufen in deinem Shop Microsoft Clarity, PostHog oder Sentry, schreibt das SDK
Werbekanal, Kampagne, Einwilligungsstand und Bestellwert als Merkmal hinein.
Damit lassen sich Aufzeichnungen und Fehler nach Dingen filtern, die diese
Werkzeuge selbst nie kennen — „nur bezahlter Google-Verkehr mit Warenkorb über
250 €", „nur die Fehler, die bezahlten Traffic treffen".

Die Werkzeuge werden dabei **nicht** von uns geladen: Wir sprechen ein globales
Objekt nur an, wenn dein Shop es selbst eingebunden hat. Es gehen ausschließlich
nicht personenbezogene Werte raus (der Bestellwert als Band, nie als Betrag).

```js
init({
  endpoint: "/td",
  clarity: false,                 // je Werkzeug abschaltbar, Standard: true
  posthog: false,
  sentry: false,
  clarityUpgradeOnPurchase: true, // Kauf-Sitzungen vor Clarity-Stichprobe schützen, Standard: false
});
```

Läuft PostHog mit Session Replay, wird zusätzlich dessen Sitzungskennung an die
Events gehängt — daraus wird in der Personen-Ansicht ein Sprung direkt in die
Aufzeichnung.

Details: <https://trackdolphin.com/docs/enrichment>

## Frameworks

- SvelteKit: <https://trackdolphin.com/docs/quickstart-sveltekit>
- Next.js (App Router): <https://trackdolphin.com/docs/nextjs>
- Warum dieser Weg: <https://trackdolphin.com/docs/abdeckung>

## Changelog

### 0.5.1

- Klaro (klaro.org, auch gehostet über KIProtect) wird erkannt: `cmp: "klaro"`.
  Hat der Besucher entschieden (`klaro.getManager().confirmed`), leitet das
  SDK die Signale aus den Zwecken der gespeicherten Dienste ab:
  `analytics`, `statistics`, `performance` → `analytics_storage`;
  `marketing`, `advertising`, `ads`, `targeting` → `ad_storage`,
  `ad_user_data`, `ad_personalization`. Eindeutige Dienstnamen
  (`google-analytics`, `google-ads`, `meta-pixel` …) zählen auch bei frei
  benannten Zwecken. `required`-Dienste zählen nicht, unbekannte Zwecke
  bleiben ohne Wirkung, und eine Gruppe ist nur erteilt, wenn alle ihre
  Dienste zugestimmt sind. Ohne Entscheidung steht nur der Name da.
- Änderungen kommen über `manager.watch()`; lädt Klaro nach dem SDK, meldet
  sich das SDK beim nächsten Blick ins Fenster an (oder über
  `window.klaroLoadWatchers`, falls die Seite so eine Liste führt).

## Lizenz

MIT
