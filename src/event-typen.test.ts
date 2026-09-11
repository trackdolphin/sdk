import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSENT_SOURCES as SDK_QUELLEN, EVENT_TYPES as SDK_TYPEN } from "./types.ts";
import { CMP_NAMES } from "./cmp.ts";
import {
  CONSENT_CMP_MAX_LENGTH,
  CONSENT_SOURCES as SCHEMA_QUELLEN,
  EVENT_TYPES as SCHEMA_TYPEN,
  parseIncomingEvent,
} from "@trackdolphin/event-schema";

test("SDK und Schema kennen dieselben Herkünfte der Einwilligung", () => {
  // Dieselbe Bauart wie bei den Ereignisarten: Eine Herkunft, die das SDK
  // schickt und der Collector nicht kennt, kostet JEDES Ereignis (400).
  assert.deepEqual([...SDK_QUELLEN].sort(), [...SCHEMA_QUELLEN].sort());
  for (const source of SDK_QUELLEN) {
    const r = parseIncomingEvent({ project_id: "p1", event_id: "abcdefgh", type: "page_view", consent: { source } });
    assert.ok(r.ok, `source ${source} wird abgewiesen: ${r.ok ? "" : r.issues.join(", ")}`);
  }
  for (const cmp of CMP_NAMES) {
    assert.ok(cmp.length <= CONSENT_CMP_MAX_LENGTH);
    const r = parseIncomingEvent({ project_id: "p1", event_id: "abcdefgh", type: "page_view", consent: { source: "cmp", cmp } });
    assert.ok(r.ok, `cmp ${cmp} wird abgewiesen`);
  }
});

/**
 * Zwei Listen an zwei Orten, und beide müssen dieselben sein.
 *
 * Das SDK hat bewusst KEINE Abhängigkeiten — es geht in fremde Browser, und
 * jedes Paket mehr ist Gewicht und Angriffsfläche. Also steht die Liste der
 * Ereignisarten dort noch einmal. Dieser Test ist der Preis dafür: Er
 * importiert beide Seiten und vergleicht sie.
 *
 * Warum das nötig ist, zeigte der 2026-09-09: Das Schema kannte `lead`,
 * `schedule`, `refund` und `contact` seit Monaten, das SDK nicht. Für jeden
 * Kunden, der das SDK benutzt, waren diese Arten damit unerreichbar — ohne
 * Fehlermeldung, ohne Warnung, ohne dass irgendwo etwas rot wurde. Der
 * Collector hätte sie angenommen; es hat sie nur nie jemand geschickt.
 *
 * Der Test läuft NUR hier, nicht im ausgelieferten Paket: `@trackdolphin/
 * event-schema` ist eine devDependency, und `files` in der package.json
 * liefert ausschliesslich `dist` aus.
 */

test("SDK und Schema kennen dieselben Ereignisarten", () => {
  const sdk = new Set<string>(SDK_TYPEN);
  const schema = new Set<string>(SCHEMA_TYPEN);

  const fehltImSdk = [...schema].filter((t) => !sdk.has(t));
  assert.deepEqual(
    fehltImSdk,
    [],
    `Das Schema kennt diese Arten, das SDK nicht — für SDK-Kunden sind sie damit unerreichbar: ${fehltImSdk.join(", ")}`,
  );

  const nurImSdk = [...sdk].filter((t) => !schema.has(t));
  assert.deepEqual(
    nurImSdk,
    [],
    `Das SDK bietet Arten an, die der Collector mit 400 abweist: ${nurImSdk.join(", ")}`,
  );
});

test("Jede angebotene Art kommt beim Collector auch durch", () => {
  // Die Listen könnten gleich sein und trotzdem falsch — etwa nach einem
  // Tippfehler in beiden. Deshalb wird jede Art einmal wirklich geprüft.
  for (const type of SDK_TYPEN) {
    const r = parseIncomingEvent({ project_id: "p1", event_id: "abcdefgh", type });
    assert.ok(r.ok, `${type} wird abgewiesen: ${r.ok ? "" : r.issues.join(", ")}`);
  }
});

test("Die neuen Felder des Ergebnis-Modells kommen durch", () => {
  // Der Grund, warum das SDK überhaupt angefasst wurde: Ohne diese beiden
  // Felder ist das Modell nur über den Sammel-Endpunkt erreichbar, also nur
  // für Historie — nicht für laufende Einbauten.
  const r = parseIncomingEvent({
    project_id: "p1",
    event_id: "abcdefgh",
    type: "cancel",
    object_id: "termin-9912",
    properties: { location: "huefingen", phone_country: "AT" },
  });
  assert.ok(r.ok, r.ok ? "" : r.issues.join(", "));
});
