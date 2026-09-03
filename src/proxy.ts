/**
 * Collect-Proxy für Headless-Shops (SvelteKit, Next.js, Nuxt, Astro, Remix …).
 *
 *   import { createCollectProxy } from "@trackdolphin/sdk/proxy";
 *   const proxy = createCollectProxy({ endpoint: "https://abc123.trdph.com/collect" });
 *   // SvelteKit: export const POST = ({ request }) => proxy(request);
 *
 * WARUM ein Proxy: Der Browser soll nur mit der eigenen Shop-Domain sprechen,
 * der Shop-Server spricht mit dem Collector. Das ist derselbe Weg, den die
 * Plugins für WooCommerce und Shopware gehen — und der einzige, den weder
 * Werbeblocker (kein fremder Hostname) noch Safari (kein Third-Party-
 * Request, kein CNAME auf fremde Infrastruktur) aushebeln können. Vor allem
 * setzt DIESER Server das Besucher-Cookie per `Set-Cookie`: Ein per
 * JavaScript gesetztes Cookie kappt Safari auf sieben Tage, ein vom eigenen
 * Server gesetztes nicht.
 *
 * Framework-neutral über Web-Standard `Request`/`Response`, ohne Node-
 * Importe — läuft auf Cloudflare Workers, Vercel Edge und Node gleich.
 */

export interface CollectProxyOptions {
  /** Vollständige Collector-URL aus der Einrichtungs-Seite (endet auf `/collect`). */
  endpoint: string;
  /** Nur nötig, wenn `endpoint` nicht der shop-eigene Ingest-Host ist. */
  shopId?: string;
  visitorCookie?: {
    /**
     * Besucherkennung erst vergeben, wenn das Event ein `consent`-Objekt mit
     * `ad_storage` oder `analytics_storage` = "granted" trägt. Standard false:
     * Das Cookie ist rein zufällig und first-party; wer es trotzdem an die
     * Einwilligung binden will (oder muss), schaltet hier um.
     */
    requireConsent?: boolean;
    /** Laufzeit des Cookies; Standard 90 Tage wie die Attribution im SDK. */
    maxAgeDays?: number;
  };
  /** Größte akzeptierte Anfrage; Standard 64 KB. */
  maxBodyBytes?: number;
  /** Zeit, die der Besucher höchstens auf den Collector wartet; Standard 2 s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Fehler landen hier — nie in der Antwort an den Browser. */
  log?: (msg: string) => void;
}

/**
 * Ein Browser-Event ist wenige Kilobyte groß. Alles darüber ist kein Tracking
 * mehr, sondern der Versuch, den Shop-Server als offenen Weiterleiter zu
 * benutzen. 64 KB ist zugleich die Grenze, die Browser für `sendBeacon` und
 * `keepalive`-fetch ziehen — größer kann echtes Tracking gar nicht ankommen.
 */
export const MAX_BODY_BYTES = 65536;

const VISITOR_COOKIE = "_td_vid";
const DEFAULT_COOKIE_DAYS = 90;
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Cookies, die der Collector auswertet (Besucherkennung, Attribution, Klick-
 * IDs, GA-Client-ID). Bewusst eine Positivliste: Der komplette Cookie-Kopf
 * eines Shops enthält Sitzungs- und Login-Cookies — die haben auf einem
 * fremden Server nichts verloren.
 */
const FORWARD_COOKIES = ["_td_vid", "_td_attr", "_fbp", "_fbc", "_ga", "_gcl_aw", "_gcl_au"] as const;

/** Mehr Glieder trägt keine echte Proxy-Kette; alles darüber bläht nur den Request auf. */
const MAX_CHAIN = 10;

function isIPv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(s: string): boolean {
  if (s.length > 45 || !s.includes(":") || !/^[0-9a-f:.]+$/i.test(s)) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((h) => (h === "" ? [] : h.split(":")));
  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    // Eingebettetes IPv4 am Ende (::ffff:1.2.3.4) zählt als zwei Gruppen.
    if (i === groups.length - 1 && g.includes(".")) {
      if (!isIPv4(g)) return false;
      count += 2;
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return false;
    count++;
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

/**
 * Jeder Kopf mit einer IP kommt vom Client oder von einem Proxy davor und
 * darf nicht als Einfallstor für beliebigen Header-Inhalt dienen — nur was
 * wirklich eine IP ist, wird weitergegeben.
 */
export function isIp(value: string): boolean {
  return isIPv4(value) || isIPv6(value);
}

/**
 * Die Kette aus `X-Forwarded-For`, auf gültige IPs reduziert. Reihenfolge
 * zählt: Der Collector liest den ERSTEN Eintrag als Besucher-IP.
 */
export function forwardedChain(headers: Headers): string[] {
  const raw = headers.get("X-Forwarded-For") ?? "";
  const chain: string[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim();
    if (candidate !== "" && isIp(candidate)) chain.push(candidate);
    if (chain.length >= MAX_CHAIN) break;
  }
  return chain;
}

/**
 * Die Adresse des Besuchers, so gut der Request sie verrät. Ein Web-Standard-
 * `Request` kennt keine Gegenstelle (kein REMOTE_ADDR) — was bleibt, sind
 * die Köpfe, die CDN oder Loadbalancer davor gesetzt haben.
 */
export function clientIp(headers: Headers): string {
  const first = forwardedChain(headers)[0];
  if (first) return first;
  for (const name of ["CF-Connecting-IP", "X-Real-IP"]) {
    const candidate = (headers.get(name) ?? "").trim();
    if (candidate !== "" && isIp(candidate)) return candidate;
  }
  return "";
}

/**
 * User-Agent des Besuchers — ohne ihn kann Meta niemanden zuordnen.
 * Steuerzeichen entfernen: Ein Zeilenumbruch im Kopf wäre eine Header-
 * Injektion in den ausgehenden Request.
 */
export function userAgent(headers: Headers): string {
  return (headers.get("User-Agent") ?? "").replace(/[\x00-\x1F\x7F]/g, "").slice(0, 512);
}

/** Cookie-Kopf zerlegen; Werte bleiben, wie der Browser sie geschickt hat. */
export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    // Ein Wert mit Steuerzeichen oder Semikolon kann kein Cookie sein — und
    // wäre im ausgehenden Kopf eine Injektion.
    if (name === "" || /[\x00-\x1F\x7F;]/.test(value)) continue;
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Ist der vorhandene Wert brauchbar? Bewusst keine strenge UUID-Prüfung:
 * Ältere Besucher tragen noch die Ersatzkennung des Browser-SDK
 * (`Math.random`-Basis, wenn `crypto.randomUUID` fehlte). Verworfen wird nur,
 * was gar keine Kennung sein kann — sonst verlöre der Besucher bei jedem
 * Aufruf seine Historie.
 */
export function validVisitorId(value: string): boolean {
  return value.length >= 8 && value.length <= 64 && /^[A-Za-z0-9._-]+$/.test(value);
}

function newVisitorId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Speicher-Einwilligung im Event: `ad_storage` ODER `analytics_storage` gewährt. */
function storageGranted(payload: Record<string, unknown>): boolean {
  const consent = payload.consent;
  if (!consent || typeof consent !== "object") return false;
  const c = consent as Record<string, unknown>;
  return c.ad_storage === "granted" || c.analytics_storage === "granted";
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Nur ein JSON-Objekt ist ein Event; Liste oder Skalar gehen unverändert weiter. */
function parseEvent(raw: string): Record<string, unknown> | null {
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Was der Browser zu sehen bekommt. Der Besucher darf nie an unserem
 * Upstream scheitern: Eine rote Zeile in der Konsole wäre ein Schaden am
 * Shop, den kein Tracking wert ist. 2xx vom Collector → 204 („nichts zu
 * sagen“), alles andere → 202 („angenommen“) — der Fehler steht im Log,
 * nicht im Browser. Nur Transportfehler und 5xx sind für das Browser-SDK
 * ein Grund, auf den direkten Collector auszuweichen; die erkennt es
 * am eigenen Statuscode dieser Route, nicht am Unterschied 204/202.
 */
export function browserStatus(upstream: number | null): number {
  return upstream !== null && upstream >= 200 && upstream < 300 ? 204 : 202;
}

export function createCollectProxy(options: CollectProxyOptions): (request: Request) => Promise<Response> {
  const {
    endpoint,
    shopId,
    maxBodyBytes = MAX_BODY_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    log = () => {},
  } = options;
  const requireConsent = options.visitorCookie?.requireConsent ?? false;
  const maxAgeDays = options.visitorCookie?.maxAgeDays ?? DEFAULT_COOKIE_DAYS;

  return async function handleCollect(request: Request): Promise<Response> {
    // Dieselbe Herkunft: kein Preflight, keine CORS-Köpfe nötig. Ein OPTIONS
    // kommt trotzdem vor (Proxys, Sicherheits-Scanner) und soll leise enden.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: "POST, OPTIONS" } });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST, OPTIONS" } });
    }

    // Erst der angekündigte, dann der tatsächliche Umfang — der Kopf kann
    // lügen, die Bytes nicht.
    const declared = Number(request.headers.get("Content-Length") ?? "0");
    if (declared > maxBodyBytes) return new Response(null, { status: 413 });
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > maxBodyBytes) return new Response(null, { status: 413 });

    const rawBody = new TextDecoder().decode(bytes);
    const payload = parseEvent(rawBody);
    const cookies = parseCookies(request.headers.get("Cookie"));
    const ip = clientIp(request.headers);
    const ua = userAgent(request.headers);

    let setCookie: string | null = null;
    if (payload) {
      // Der Collector läuft hinter Cloudflare und liest die Absender-IP aus
      // `CF-Connecting-IP` — bei einem Server-zu-Server-Request ist das der
      // Shop-Server, nicht der Besucher. Die Felder im Payload schlagen dort
      // die Kopfzeilen; nur über sie kommt das echte Besuchersignal an.
      // Vorhandene Werte bleiben: Wer sie setzt, weiß es besser.
      if (isEmpty(payload.client_ip) && ip !== "") payload.client_ip = ip;
      if (isEmpty(payload.client_user_agent) && ua !== "") payload.client_user_agent = ua;
      if (isEmpty(payload.shop_id) && shopId) payload.shop_id = shopId;

      const existing = cookies.get(VISITOR_COOKIE) ?? "";
      const known = validVisitorId(existing) ? existing : "";
      // Mit „erst nach Einwilligung“ zählt allein, was DIESES Event über die
      // Einwilligung sagt — der Server hat keine andere Quelle.
      const allowed = !requireConsent || storageGranted(payload);
      if (allowed) {
        const vid = known || newVisitorId();
        if (isEmpty(payload.visitor_id)) payload.visitor_id = vid;
        // Auch eine vorhandene Kennung wird neu ausgestellt: Hat das Browser-
        // SDK sie einst per JavaScript gesetzt, lebt sie in Safari nur sieben
        // Tage — erst das Set-Cookie vom eigenen Server gibt ihr die volle
        // Laufzeit zurück. Und jeder Besuch verlängert sie (gleitendes Fenster).
        const secure = request.url.startsWith("https:") ? "; Secure" : "";
        // Kein HttpOnly: Das Browser-SDK liest die Kennung, um sie auch dann
        // mitzuschicken, wenn es einmal direkt an den Collector ausweicht.
        setCookie = `${VISITOR_COOKIE}=${vid}; Max-Age=${maxAgeDays * 86400}; Path=/; SameSite=Lax${secure}`;
        cookies.set(VISITOR_COOKIE, vid);
      } else {
        // Ohne Einwilligung weder Cookie noch Kennung — auch keine, die der
        // Browser auf eigene Faust mitgeschickt hat: Die strengere Einstellung
        // gewinnt, sonst wäre sie hier wirkungslos.
        delete payload.visitor_id;
      }
    }

    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    // Nur die vorhandene Kette, nichts Erfundenes: Ein Web-Request kennt
    // seine Gegenstelle nicht, also gibt es nichts anzuhängen.
    const chain = forwardedChain(request.headers);
    if (chain.length === 0 && ip !== "") chain.push(ip);
    if (chain.length > 0) headers["X-Forwarded-For"] = chain.join(", ");
    if (ua !== "") headers["User-Agent"] = ua;
    const cookieHeader = FORWARD_COOKIES.filter((name) => cookies.get(name))
      .map((name) => `${name}=${cookies.get(name)}`)
      .join("; ");
    if (cookieHeader !== "") headers.Cookie = cookieHeader;

    let upstream: number | null = null;
    try {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: payload ? JSON.stringify(payload) : rawBody,
        // Kurz: Der Besucher wartet auf diese Antwort. Lieber ein verlorenes
        // Event als eine hängende Seite.
        signal: AbortSignal.timeout(timeoutMs),
      });
      upstream = res.status;
      if (!res.ok) log(`Collector antwortete mit Status ${res.status}`);
      // Den Antwortkörper nicht offen lassen — Worker-Laufzeiten zählen ihn
      // als hängende Verbindung.
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      log(`Collector nicht erreichbar: ${String(e)}`);
    }

    const responseHeaders: Record<string, string> = { "Cache-Control": "no-store" };
    if (setCookie) responseHeaders["Set-Cookie"] = setCookie;
    return new Response(null, { status: browserStatus(upstream), headers: responseHeaders });
  };
}
