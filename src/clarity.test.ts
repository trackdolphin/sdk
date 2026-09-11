import { test } from "node:test";
import assert from "node:assert/strict";
import { clarityAdapter, upgradeClarity } from "./clarity.ts";

/** Fängt ab, was an Clarity gegangen wäre. */
function fakeClarity() {
  const calls: Array<[string, string, string?]> = [];
  (globalThis as Record<string, unknown>).clarity = (cmd: string, a: string, b?: string) => {
    calls.push([cmd, a, b]);
  };
  return calls;
}

const sets = (calls: Array<[string, string, string?]>) =>
  calls.filter((c) => c[0] === "set").map((c) => [c[1], c[2]]);

function removeClarity() {
  delete (globalThis as Record<string, unknown>).clarity;
}

test("ohne Clarity im Shop passiert nichts — und es wirft nicht", () => {
  clarityAdapter.reset();
  removeClarity();
  assert.equal(clarityAdapter.apply({ td_channel: "google_paid" }), false);
  clarityAdapter.reset(); // sonst überlebt der Wiederhol-Timer den Test
});

test("jeder Schlüssel geht genau einmal raus — `set` hängt an, es überschreibt nicht", () => {
  clarityAdapter.reset();
  const calls = fakeClarity();

  clarityAdapter.apply({ td_channel: "google_paid" });
  clarityAdapter.apply({ td_channel: "google_paid", td_consent: "granted" });

  assert.deepEqual(sets(calls), [
    ["td_channel", "google_paid"],
    ["td_consent", "granted"],
  ]);

  // Selbst ein geänderter Kanal darf `td_channel` nicht ein zweites Mal setzen —
  // sonst stünde die Sitzung unter beiden Kanälen im Filter.
  clarityAdapter.apply({ td_channel: "meta_paid" });
  assert.equal(sets(calls).length, 2);

  removeClarity();
  clarityAdapter.reset();
});

test("upgrade wird durchgereicht und ist ohne Clarity folgenlos", () => {
  clarityAdapter.reset();
  const calls = fakeClarity();
  assert.equal(upgradeClarity("trackdolphin_purchase"), true);
  assert.deepEqual(calls.at(-1), ["upgrade", "trackdolphin_purchase", undefined]);
  removeClarity();
  assert.equal(upgradeClarity("trackdolphin_purchase"), false);
  clarityAdapter.reset();
});

test("ein werfendes Clarity reißt nichts mit", () => {
  clarityAdapter.reset();
  (globalThis as Record<string, unknown>).clarity = () => {
    throw new Error("clarity ist kaputt");
  };
  assert.doesNotThrow(() => clarityAdapter.apply({ td_channel: "direct" }));
  removeClarity();
  clarityAdapter.reset();
});
