import { test } from "node:test";
import assert from "node:assert/strict";
import { sentryAdapter } from "./sentry.ts";

function setzeSentry(s: unknown) {
  (globalThis as Record<string, unknown>).Sentry = s;
}
function entferneSentry() {
  delete (globalThis as Record<string, unknown>).Sentry;
}

test("ohne Sentry im Shop passiert nichts", () => {
  entferneSentry();
  assert.equal(sentryAdapter.apply({ td_channel: "direct" }), false);
});

test("der CDN-Loader-Stub kennt kein setTag — wir gehen deshalb über onLoad", () => {
  // Genau die Form, an der ein naives `Sentry.setTag(...)` mit einem
  // TypeError stirbt: `Sentry` existiert, `setTag` nicht.
  const wartend: Array<() => void> = [];
  const gesetzt: Record<string, string>[] = [];
  setzeSentry({
    onLoad: (cb: () => void) => void wartend.push(cb),
  });

  assert.doesNotThrow(() => sentryAdapter.apply({ td_channel: "google_paid" }));
  assert.equal(sentryAdapter.apply({ td_channel: "google_paid" }), true);

  // Erst wenn das echte SDK da ist, wird geschrieben.
  setzeSentry({
    onLoad: (cb: () => void) => cb(),
    setTags: (t: Record<string, string>) => gesetzt.push(t),
  });
  for (const cb of wartend) cb();
  assert.deepEqual(gesetzt.at(-1), { td_channel: "google_paid" });
  entferneSentry();
});

test("npm-Einbindung: onLoad ruft sofort, die Merkmale stehen direkt", () => {
  const gesetzt: Record<string, string>[] = [];
  setzeSentry({
    onLoad: (cb: () => void) => cb(),
    setTags: (t: Record<string, string>) => gesetzt.push(t),
  });
  assert.equal(sentryAdapter.apply({ td_channel: "meta_paid", td_consent: "granted" }), true);
  assert.deepEqual(gesetzt, [{ td_channel: "meta_paid", td_consent: "granted" }]);
  entferneSentry();
});

test("setTag überschreibt — der zweite Satz gilt", () => {
  const gesetzt: Array<[string, string]> = [];
  setzeSentry({
    onLoad: (cb: () => void) => cb(),
    setTag: (k: string, v: string) => gesetzt.push([k, v]),
  });
  sentryAdapter.apply({ td_channel: "google_paid" });
  sentryAdapter.apply({ td_channel: "meta_paid" });
  assert.deepEqual(gesetzt, [
    ["td_channel", "google_paid"],
    ["td_channel", "meta_paid"],
  ]);
  entferneSentry();
});

test("altes Bündel ohne onLoad: nur schreiben, wenn die Methode wirklich da ist", () => {
  const gesetzt: Record<string, string>[] = [];
  setzeSentry({ setTags: (t: Record<string, string>) => gesetzt.push(t) });
  assert.equal(sentryAdapter.apply({ td_channel: "direct" }), true);
  assert.deepEqual(gesetzt, [{ td_channel: "direct" }]);

  // Weder onLoad noch setTag/setTags — dann eben nicht, aber ohne Wurf.
  setzeSentry({ captureException: () => {} });
  assert.equal(sentryAdapter.apply({ td_channel: "direct" }), false);
  entferneSentry();
});

test("ein werfendes Sentry reißt nichts mit", () => {
  setzeSentry({
    onLoad: (cb: () => void) => cb(),
    setTags: () => {
      throw new Error("sentry ist kaputt");
    },
  });
  assert.doesNotThrow(() => sentryAdapter.apply({ td_channel: "direct" }));
  entferneSentry();
});
