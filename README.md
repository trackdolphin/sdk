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
(`_td_vid`, `_td_attr`, `_fbp`, `_fbc`, `_ga`, `_gcl_aw`, `_gcl_au`), setzt
`_td_vid` als Server-Cookie (90 Tage) und antwortet dem Browser mit `204`
oder `202` — Fehler gehen an `log`, nie an den Besucher. Optionen:
`shopId`, `visitorCookie: { requireConsent, maxAgeDays }`, `maxBodyBytes`,
`timeoutMs`, `fetchImpl`, `log`.

## Im Browser

```js
import { init, track, setConsent } from "@trackdolphin/sdk";

// Relativ → Proxy-Route. Die Besucherkennung vergibt die Route, das SDK liest sie nur.
init({ endpoint: "/td", requireConsent: true });

// Aus dem Cookie-Banner — boolean oder granular nach Consent Mode v2:
setConsent({ ad_storage: "granted", analytics_storage: "granted",
             ad_user_data: "granted", ad_personalization: "denied" });

track({ type: "view_item", items: [{ id: "SKU-1", name: "Laufschuh", price: 119.9 }] });
```

Ohne Server-Route geht auch die direkte Collector-URL
(`init({ endpoint: "https://abc123.trdph.com/collect" })`) — dann setzt das SDK
das Besucher-Cookie selbst, und Werbeblocker sowie Safari holen sich ihren
Anteil. Mit `fallbackEndpoint` weicht das SDK für die Sitzung dorthin aus,
falls die Proxy-Route einmal nicht antwortet.

Das SDK erfasst First-Touch-Attribution (90 Tage) und Klick-IDs (`gclid`,
`fbclid`, `ttclid`, …), hasht E-Mail und Telefon lokal (SHA-256) und puffert
Events, bis die Einwilligung vorliegt.

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

await identify({ email: user.email, externalId: user.id, traits: { plan: "pro" } });
// … ab jetzt trägt jedes Event em/ph/external_id; beim Logout:
reset();
```

Gespeichert werden nur Hashes und `externalId` (localStorage `_td_id`), nie Klartext.

## Frameworks

- SvelteKit: <https://trackdolphin.com/docs/quickstart-sveltekit>
- Next.js (App Router): <https://trackdolphin.com/docs/nextjs>
- Warum dieser Weg: <https://trackdolphin.com/docs/abdeckung>

## Lizenz

MIT
