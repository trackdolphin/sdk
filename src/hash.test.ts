import { test } from "node:test";
import assert from "node:assert/strict";

test("Telefon: zwei Hashes, weil die Plattformen sich beim Plus uneinig sind", async () => {
  // Meta verlangt „491712345678“, Google Ads und GA4 verlangen „+491712345678“.
  // Zwei Eingaben, zwei Hashes — EIN Hash kann nicht beide bedienen. Vorher
  // ging derselbe Hash an beide: Treffer bei Meta, tot bei Google.
  const { hashPhone, hashPhoneE164 } = await import("./hash.ts");
  const meta = await hashPhone("0171 2345678", "49");
  const google = await hashPhoneE164("0171 2345678", "49");

  const sha = async (s: string) => {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  assert.equal(meta, await sha("491712345678"));
  assert.equal(google, await sha("+491712345678"));
  assert.notEqual(meta, google);
});

test("beide Telefon-Hashes entstehen aus derselben Normalisierung", async () => {
  const { hashPhone, hashPhoneE164 } = await import("./hash.ts");
  // Verschiedene Schreibweisen derselben Nummer → jeweils identische Hashes.
  for (const eingabe of ["+49 171 2345678", "0171/23 45 678", "0049 171 2345678"]) {
    assert.equal(await hashPhone(eingabe, "49"), await hashPhone("01712345678", "49"), eingabe);
    assert.equal(await hashPhoneE164(eingabe, "49"), await hashPhoneE164("01712345678", "49"), eingabe);
  }
});
