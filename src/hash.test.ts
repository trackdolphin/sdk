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

test("Name: kleinschreiben, trimmen, Titel und Ziffern raus, Umlaute bleiben", async () => {
  const { normalizeName } = await import("./hash.ts");
  assert.equal(normalizeName("  Anna  "), "anna");
  assert.equal(normalizeName("Dr. Anna"), "anna", "Google verlangt: keine Präfixe");
  assert.equal(normalizeName("Berg Jr."), "berg", "Google verlangt: keine Suffixe");
  assert.equal(normalizeName("Anna2"), "anna", "Ziffern in einem Vornamen sind ein Tippfehler");
  assert.equal(normalizeName("Maria   Anna"), "maria anna", "innere Leerzeichen bleiben, aber nur eines");
  assert.equal(normalizeName("van der Berg"), "van der berg");
});

test("Name: Umlaute und Akzente werden NICHT nach ASCII umgeschrieben", async () => {
  // Meta zeigt „Valéry" → „valéry" mit eigenem Beispielhash, Google sagt
  // „Accents are allowed". Eine Umschrift ä→ae erzeugte einen Hash, den keine
  // Plattform je berechnet — und der Fehler fiele niemandem auf.
  const { normalizeName, hashName } = await import("./hash.ts");
  assert.equal(normalizeName("Müller"), "müller");
  assert.equal(normalizeName("Valéry"), "valéry");
  assert.notEqual(await hashName("Müller"), await hashName("Mueller"));
  assert.notEqual(await hashName("Müller"), await hashName("Muller"));
});

test("Name: NFC, zusammengesetztes und fertiges Umlaut-ü ergeben denselben Hash", async () => {
  // Dieselben Buchstaben, zwei Unicode-Schreibweisen: „ü“ als ein Zeichen und
  // als u + Trema. Ohne NFC wären das zwei Hashes für eine Person — ein
  // macOS-Dateidialog liefert die eine Form, ein Web-Formular die andere.
  const { hashName } = await import("./hash.ts");
  const fertig = "M\u00fcller";
  const zusammengesetzt = "Mu\u0308ller";
  assert.notEqual(fertig, zusammengesetzt, "die Eingaben sind wirklich verschieden");
  assert.equal(await hashName(fertig), await hashName(zusammengesetzt));
});

test("Name: Satzzeichen bleiben, Googles „smith-jones“ ist ein gültiger Nachname", async () => {
  const { normalizeName } = await import("./hash.ts");
  assert.equal(normalizeName("Anne-Marie"), "anne-marie");
  assert.equal(normalizeName("O'Brien"), "o'brien");
});

test("Name: bleibt nichts übrig, gibt es keinen Hash statt eines Hashes vom Leerstring", async () => {
  // Der Hash des Leerstrings wäre bei jedem Besucher derselbe — ein
  // Match-Signal, das alle Menschen zu einer Person zusammenzieht.
  const { hashName } = await import("./hash.ts");
  assert.equal(await hashName("  "), "");
  assert.equal(await hashName("Dr."), "");
  assert.equal(await hashName("42"), "");
});
