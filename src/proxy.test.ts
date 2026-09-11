/**
 * Collect-Proxy unter node --test — mit gefaketem fetch, damit sichtbar ist,
 * WAS beim Collector ankäme: Köpfe, Cookies, Payload.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollectProxy, clientIp, forwardedChain, isIp, userAgent } from "./proxy.ts";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | string;
}

/** Baut Proxy + Aufzeichnung; `status` ist die Antwort des gefakten Collectors. */
function harness(opts: { status?: number; fail?: boolean; proxy?: Parameters<typeof createCollectProxy>[0] } = {}) {
  const calls: Captured[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (opts.fail) throw new Error("ECONNREFUSED");
    const raw = String(init?.body);
    let body: Captured["body"] = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      /* Rohtext bleibt Rohtext */
    }
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body });
    return new Response(null, { status: opts.status ?? 202 });
  }) as typeof fetch;
  const proxy = createCollectProxy({
    endpoint: "https://abc123.trdph.com/collect",
    fetchImpl,
    log: (m) => logs.push(m),
    ...opts.proxy,
  });
  return { proxy, calls, logs };
}

function post(body: unknown, headers: Record<string, string> = {}, url = "https://shop.test/td"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("IP-Prüfung: IPv4, IPv6 (auch verkürzt und mit eingebettetem IPv4), sonst nichts", () => {
  assert.ok(isIp("203.0.113.9"));
  assert.ok(isIp("2001:db8::1"));
  assert.ok(isIp("::1"));
  assert.ok(isIp("::ffff:203.0.113.9"));
  assert.ok(isIp("2001:0db8:85a3:0000:0000:8a2e:0370:7334"));
  assert.equal(isIp("256.1.1.1"), false);
  assert.equal(isIp("203.0.113.9:8080"), false);
  assert.equal(isIp("2001:db8:::1"), false);
  assert.equal(isIp("unknown"), false);
  assert.equal(isIp("<script>"), false);
  assert.equal(isIp(""), false);
});

test("X-Forwarded-For: nur gültige Glieder, Reihenfolge bleibt, Kette gedeckelt", () => {
  const h = new Headers({ "X-Forwarded-For": "203.0.113.9, kaputt, 10.0.0.1 , 2001:db8::1" });
  assert.deepEqual(forwardedChain(h), ["203.0.113.9", "10.0.0.1", "2001:db8::1"]);
  const lang = new Headers({ "X-Forwarded-For": Array.from({ length: 30 }, (_, i) => `10.0.0.${i + 1}`).join(",") });
  assert.equal(forwardedChain(lang).length, 10);
});

test("Besucher-IP: erstes gültiges XFF-Glied, sonst CF-Connecting-IP, sonst X-Real-IP", () => {
  assert.equal(clientIp(new Headers({ "X-Forwarded-For": "junk, 203.0.113.9", "CF-Connecting-IP": "198.51.100.1" })), "203.0.113.9");
  assert.equal(clientIp(new Headers({ "X-Forwarded-For": "junk", "CF-Connecting-IP": "198.51.100.1" })), "198.51.100.1");
  assert.equal(clientIp(new Headers({ "X-Real-IP": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(new Headers({ "X-Real-IP": "nicht-ip" })), "");
});

test("User-Agent: Steuerzeichen raus, 512 Zeichen Deckel", () => {
  // CR, LF und NUL lehnt schon die Headers-Klasse ab; die übrigen Steuerzeichen
  // (ESC, DEL, …) kommen durch und dürfen den ausgehenden Kopf nicht erreichen.
  assert.equal(userAgent(new Headers({ "User-Agent": "Mozilla/5.0\x1b[31m\x01 X\x7f" })), "Mozilla/5.0[31m X");
  assert.equal(userAgent(new Headers({ "User-Agent": "x".repeat(700) })).length, 512);
  assert.equal(userAgent(new Headers()), "");
});

test("Methoden: OPTIONS → 204, GET → 405 mit Allow, nichts geht zum Collector", async () => {
  const { proxy, calls } = harness();
  const options = await proxy(new Request("https://shop.test/td", { method: "OPTIONS" }));
  assert.equal(options.status, 204);
  const get = await proxy(new Request("https://shop.test/td", { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST, OPTIONS");
  assert.equal(calls.length, 0);
});

test("Größe: über 64 KB → 413, sowohl per Content-Length als auch nach den Bytes", async () => {
  const { proxy, calls } = harness();
  const big = JSON.stringify({ type: "custom", pad: "x".repeat(70000) });
  assert.equal((await proxy(post(big))).status, 413);
  // Content-Length allein lügt schon → gar nicht erst lesen.
  const lie = new Request("https://shop.test/td", {
    method: "POST",
    headers: { "Content-Length": "999999" },
    body: "{}",
  });
  assert.equal((await proxy(lie)).status, 413);
  assert.equal(calls.length, 0);
  // Eigene Grenze
  const klein = harness({ proxy: { endpoint: "https://x/collect", maxBodyBytes: 10 } });
  assert.equal((await klein.proxy(post({ type: "view_item" }))).status, 413);
});

test("Payload wird um client_ip, client_user_agent, shop_id ergänzt — vorhandene Werte bleiben", async () => {
  const { proxy, calls } = harness({ proxy: { endpoint: "https://x/collect", shopId: "shop_1" } });
  await proxy(post({ type: "view_item" }, { "X-Forwarded-For": "203.0.113.9, 10.0.0.1", "User-Agent": "UA/1" }));
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.client_ip, "203.0.113.9");
  assert.equal(body.client_user_agent, "UA/1");
  assert.equal(body.shop_id, "shop_1");

  await proxy(
    post(
      { type: "view_item", client_ip: "1.2.3.4", client_user_agent: "eigen", shop_id: "anders" },
      { "X-Forwarded-For": "203.0.113.9", "User-Agent": "UA/1" },
    ),
  );
  const second = calls[1]!.body as Record<string, unknown>;
  assert.equal(second.client_ip, "1.2.3.4");
  assert.equal(second.client_user_agent, "eigen");
  assert.equal(second.shop_id, "anders");
});

test("Weiterleitung: text/plain, XFF-Kette ohne Erfundenes, User-Agent, Ziel-URL", async () => {
  const { proxy, calls } = harness();
  await proxy(post({ type: "view_item" }, { "X-Forwarded-For": "203.0.113.9, junk, 10.0.0.1", "User-Agent": "UA/2" }));
  const h = calls[0]!.headers;
  assert.equal(calls[0]!.url, "https://abc123.trdph.com/collect");
  assert.equal(h["Content-Type"], "text/plain");
  assert.equal(h["X-Forwarded-For"], "203.0.113.9, 10.0.0.1");
  assert.equal(h["User-Agent"], "UA/2");

  // Ohne XFF, aber mit CF-Connecting-IP: die bekannte IP, nichts weiter.
  await proxy(post({ type: "view_item" }, { "CF-Connecting-IP": "198.51.100.1" }));
  assert.equal(calls[1]!.headers["X-Forwarded-For"], "198.51.100.1");
  // Ohne jede IP: kein Kopf statt eines leeren.
  await proxy(post({ type: "view_item" }));
  assert.equal("X-Forwarded-For" in calls[2]!.headers, false);
});

test("Cookie-Positivliste: Tracking-Cookies gehen mit, Sitzungs-Cookies nie", async () => {
  const { proxy, calls } = harness();
  await proxy(
    post(
      { type: "view_item" },
      { Cookie: "PHPSESSID=geheim; _ga=GA1.1.123.456; wordpress_logged_in=admin; _fbp=fb.1.1.2; _td_attr=%7B%7D; _gcl_au=1.1.9" },
    ),
  );
  const cookie = calls[0]!.headers.Cookie ?? "";
  assert.match(cookie, /_ga=GA1\.1\.123\.456/);
  assert.match(cookie, /_fbp=fb\.1\.1\.2/);
  assert.match(cookie, /_td_attr=%7B%7D/);
  assert.match(cookie, /_gcl_au=1\.1\.9/);
  assert.doesNotMatch(cookie, /PHPSESSID|geheim|wordpress_logged_in|admin/);
  // Auch der Payload trägt nichts davon.
  assert.doesNotMatch(JSON.stringify(calls[0]!.body), /geheim|admin/);
});

test("Besucher-Cookie: fehlt _td_vid, vergibt der Proxy eine Kennung — Set-Cookie und visitor_id stimmen überein", async () => {
  const { proxy, calls } = harness();
  const res = await proxy(post({ type: "view_item" }));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const m = setCookie.match(/^_td_vid=([a-f0-9]{32}); Max-Age=7776000; Path=\/; SameSite=Lax; Secure$/);
  assert.ok(m, `Set-Cookie unerwartet: ${setCookie}`);
  const body = calls[0]!.body as Record<string, unknown>;
  assert.equal(body.visitor_id, m![1]);
  assert.match(calls[0]!.headers.Cookie ?? "", new RegExp(`_td_vid=${m![1]}`));
});

test("Besucher-Cookie: ohne https kein Secure; eigene Laufzeit", async () => {
  const { proxy } = harness({ proxy: { endpoint: "https://x/collect", visitorCookie: { maxAgeDays: 30 } } });
  const res = await proxy(post({ type: "view_item" }, {}, "http://localhost:5173/td"));
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  assert.match(setCookie, /Max-Age=2592000/);
  assert.doesNotMatch(setCookie, /Secure/);
});

test("Besucher-Cookie: vorhandene Kennung wird übernommen und neu ausgestellt, nicht ersetzt", async () => {
  const { proxy, calls } = harness();
  const res = await proxy(post({ type: "view_item" }, { Cookie: "_td_vid=bestehend-123" }));
  assert.match(res.headers.get("Set-Cookie") ?? "", /^_td_vid=bestehend-123;/);
  assert.equal((calls[0]!.body as Record<string, unknown>).visitor_id, "bestehend-123");

  // Unbrauchbarer Wert → neue Kennung statt Müll weiterreichen.
  const res2 = await proxy(post({ type: "view_item" }, { Cookie: "_td_vid=x" }));
  assert.match(res2.headers.get("Set-Cookie") ?? "", /^_td_vid=[a-f0-9]{32};/);
  // Eine visitor_id im Payload hat Vorrang vor dem Cookie.
  await proxy(post({ type: "view_item", visitor_id: "aus-dem-sdk" }, { Cookie: "_td_vid=bestehend-123" }));
  assert.equal((calls[2]!.body as Record<string, unknown>).visitor_id, "aus-dem-sdk");
});

test("requireConsent: ohne Speicher-Einwilligung im Event weder Cookie noch visitor_id", async () => {
  const { proxy, calls } = harness({ proxy: { endpoint: "https://x/collect", visitorCookie: { requireConsent: true } } });

  const ohne = await proxy(post({ type: "view_item", visitor_id: "vom-browser" }));
  assert.equal(ohne.headers.get("Set-Cookie"), null);
  assert.equal("visitor_id" in (calls[0]!.body as object), false, "strengere Einstellung gewinnt");

  const verweigert = await proxy(post({ type: "view_item", consent: { ad_storage: "denied", analytics_storage: "denied" } }));
  assert.equal(verweigert.headers.get("Set-Cookie"), null);
  assert.equal("visitor_id" in (calls[1]!.body as object), false);

  const gewaehrt = await proxy(post({ type: "view_item", consent: { ad_storage: "denied", analytics_storage: "granted" } }));
  assert.match(gewaehrt.headers.get("Set-Cookie") ?? "", /^_td_vid=[a-f0-9]{32};/);
  assert.match(String((calls[2]!.body as Record<string, unknown>).visitor_id), /^[a-f0-9]{32}$/);
});

test("Antwort: 204 bei 2xx vom Collector, 202 sonst — mit Logzeile, nie mit Fehler im Browser", async () => {
  const ok = harness({ status: 202 });
  const r1 = await ok.proxy(post({ type: "view_item" }));
  assert.equal(r1.status, 204);
  assert.equal(await r1.text(), "");
  assert.equal(ok.logs.length, 0);

  const bad = harness({ status: 400 });
  const r2 = await bad.proxy(post({ type: "view_item" }));
  assert.equal(r2.status, 202);
  assert.equal(await r2.text(), "");
  assert.deepEqual(bad.logs, ["Collector antwortete mit Status 400"]);

  const down = harness({ fail: true });
  const r3 = await down.proxy(post({ type: "view_item" }));
  assert.equal(r3.status, 202);
  assert.match(down.logs[0] ?? "", /nicht erreichbar/);
  // Das Cookie wird trotzdem gesetzt — sonst bekäme das nächste Event eine neue Kennung.
  assert.match(r3.headers.get("Set-Cookie") ?? "", /^_td_vid=/);
});

test("Kein JSON-Objekt: Rohtext geht unverändert weiter, kein Cookie", async () => {
  const { proxy, calls } = harness();
  const res = await proxy(post("[1,2,3]"));
  assert.deepEqual(calls[0]!.body, [1, 2, 3]);
  assert.equal(res.headers.get("Set-Cookie"), null);
  await proxy(post("kein json"));
  assert.equal(calls[1]!.body, "kein json");
});


// ---------------------------------------------------------------------------
// Trackdolphin Consent: Nebenwege für Banner-Konfiguration und Nachweis
// ---------------------------------------------------------------------------
test("Proxy: /consent-banner holt die veröffentlichte Fassung vom Collector, mit Projekt", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ schema: 1, projectId: "p1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const handle = createCollectProxy({ endpoint: "https://abc.trdph.com/collect", shopId: "p1", fetchImpl });
  const res = await handle(new Request("https://shop.example/td/consent-banner", { method: "GET" }));
  assert.equal(res.status, 200);
  assert.equal(calls[0]!.url, "https://abc.trdph.com/collect/consent-banner?project=p1");
  assert.equal((await res.json()).schema, 1);
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=60");
});

test("Proxy: ohne veröffentlichte Fassung antwortet /consent-banner leer mit 404", async () => {
  const fetchImpl = (async () => new Response('{"error":"no_banner"}', { status: 404 })) as unknown as typeof fetch;
  const handle = createCollectProxy({ endpoint: "https://abc.trdph.com/collect", fetchImpl });
  const res = await handle(new Request("https://shop.example/td/consent-banner"));
  assert.equal(res.status, 404);
});

test("Proxy: /consent reicht die Entscheidung mit Projektkennung an den Collector weiter", async () => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: String(init?.body ?? "") });
    return new Response('{"ok":true}', { status: 202 });
  }) as unknown as typeof fetch;
  const handle = createCollectProxy({ endpoint: "https://abc.trdph.com/collect", shopId: "p1", fetchImpl });
  const res = await handle(new Request("https://shop.example/td/consent", {
    method: "POST",
    body: JSON.stringify({ decision: { v: 1, action: "accept_all", purposes: { marketing: true } }, lang: "de" }),
  }));
  assert.equal(res.status, 204);
  assert.equal(calls[0]!.url, "https://abc.trdph.com/collect/consent");
  const body = JSON.parse(calls[0]!.body);
  assert.equal(body.project_id, "p1");
  assert.equal(body.decision.action, "accept_all");
  // Ohne Entscheidung: 400, und nichts geht an den Collector.
  const leer = await handle(new Request("https://shop.example/td/consent", { method: "POST", body: '{"lang":"de"}' }));
  assert.equal(leer.status, 400);
  assert.equal(calls.length, 1);
});
