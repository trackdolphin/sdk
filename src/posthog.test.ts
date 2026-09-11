import { test } from "node:test";
import assert from "node:assert/strict";
import { posthogAdapter, readPostHogSessionId } from "./posthog.ts";

function setzePostHog(ph: unknown) {
  (globalThis as Record<string, unknown>).posthog = ph;
}
function entfernePostHog() {
  delete (globalThis as Record<string, unknown>).posthog;
}

/** Der Warteschlangen-Stub des offiziellen Snippets: puffert, gibt nichts zurück. */
function stub() {
  const gepuffert: unknown[][] = [];
  return {
    _i: [] as unknown[],
    __SV: 1,
    register: (...args: unknown[]) => void gepuffert.push(["register", ...args]),
    get_session_id: () => undefined as unknown as string,
    gepuffert,
  };
}

test("ohne PostHog im Shop passiert nichts", () => {
  entfernePostHog();
  assert.equal(posthogAdapter.apply({ td_channel: "direct" }), false);
  assert.equal(readPostHogSessionId(), null);
});

test("Merkmale gehen auch an den Stub — er puffert sie und spielt sie später ab", () => {
  const s = stub();
  setzePostHog(s);
  assert.equal(posthogAdapter.apply({ td_channel: "google_paid" }), true);
  assert.deepEqual(s.gepuffert.at(-1), ["register", { td_channel: "google_paid" }]);
  entfernePostHog();
});

test("register überschreibt — wir dürfen mit dem vollen Satz nachfassen", () => {
  const aufrufe: Record<string, unknown>[] = [];
  setzePostHog({ __loaded: true, register: (p: Record<string, unknown>) => aufrufe.push(p) });

  posthogAdapter.apply({ td_channel: "google_paid" });
  posthogAdapter.apply({ td_channel: "google_paid", td_consent: "granted" });

  // Anders als bei Clarity ist der zweite Aufruf erwünscht und unschädlich.
  assert.equal(aufrufe.length, 2);
  assert.deepEqual(aufrufe[1], { td_channel: "google_paid", td_consent: "granted" });
  entfernePostHog();
});

test("die Sitzungskennung wird NIE vom Stub geholt", () => {
  // Der Stub hat kein `return` — er lieferte `undefined` statt einer Kennung.
  setzePostHog(stub());
  assert.equal(readPostHogSessionId(), null, "__loaded fehlt, also kein Lesen");
  entfernePostHog();
});

test("die Sitzungskennung kommt nur, wenn auch wirklich aufgezeichnet wird", () => {
  // Geladen, aber Replay läuft nicht: ein Link führte ins Leere.
  setzePostHog({ __loaded: true, get_session_id: () => "sess-1", sessionRecordingStarted: () => false });
  assert.equal(readPostHogSessionId(), null);

  setzePostHog({ __loaded: true, get_session_id: () => "sess-1", sessionRecordingStarted: () => true });
  assert.equal(readPostHogSessionId(), "sess-1");

  // Leere Kennung ist keine Kennung.
  setzePostHog({ __loaded: true, get_session_id: () => "", sessionRecordingStarted: () => true });
  assert.equal(readPostHogSessionId(), null);
  entfernePostHog();
});

test("ein werfendes PostHog reißt nichts mit", () => {
  setzePostHog({
    __loaded: true,
    register: () => {
      throw new Error("posthog ist kaputt");
    },
    get_session_id: () => {
      throw new Error("auch das");
    },
    sessionRecordingStarted: () => true,
  });
  assert.doesNotThrow(() => posthogAdapter.apply({ td_channel: "direct" }));
  assert.equal(posthogAdapter.apply({ td_channel: "direct" }), false);
  assert.equal(readPostHogSessionId(), null);
  entfernePostHog();
});
