/**
 * Adapter: Sentry.
 *
 * Hier liegt die Falle, in die ein naives `if (window.Sentry) Sentry.setTag(…)`
 * läuft: Bei Einbindung über das CDN-Loader-Skript existiert `window.Sentry`
 * zwar sofort, aber `setTag` ist in dessen Stub NICHT enthalten. Die gepufferte
 * Liste ist serverseitig festgelegt und umfasst nur `init`, `captureException`
 * und Verwandte. Ein direkter Aufruf wirft dann
 * `TypeError: Sentry.setTag is not a function`.
 *
 * Der eine Pfad, der beide Einbindungsarten abdeckt, ist `Sentry.onLoad()`: Der
 * Loader definiert es sofort (und ruft den Callback direkt auf, wenn das SDK
 * schon da ist), und das npm-SDK exportiert es ebenfalls — dort als sofortiger
 * Aufruf. Günstig obendrein: Der Loader arbeitet erst die `onLoad`-Callbacks ab
 * und dann `init` aus der Warteschlange, unsere Merkmale stehen also schon,
 * bevor das erste Ereignis entsteht.
 *
 * `setTag` schreibt auf den Isolation Scope, der im Browser ein Seiten-Singleton
 * ist — die Merkmale hängen damit an allen FOLGENDEN Ereignissen der Seite.
 * Bereits gesendete Fehler bleiben unverändert; Merkmale werden erst beim
 * Aufbereiten eines Ereignisses zusammengeführt.
 */

import type { EnrichmentAdapter } from "./enrichment.ts";

interface SentryLike {
  onLoad?: (cb: () => void) => void;
  setTags?: (tags: Record<string, string>) => void;
  setTag?: (key: string, value: string) => void;
}

function sentryObj(): SentryLike | null {
  try {
    const s = (globalThis as { Sentry?: unknown }).Sentry;
    return s && typeof s === "object" ? (s as SentryLike) : null;
  } catch {
    return null;
  }
}

/** Merkmale setzen — `setTags` wenn vorhanden, sonst einzeln. */
function schreibe(s: SentryLike, tags: Record<string, string>): void {
  if (typeof s.setTags === "function") {
    s.setTags(tags);
    return;
  }
  if (typeof s.setTag === "function") {
    for (const [key, value] of Object.entries(tags)) s.setTag(key, value);
  }
}

export const sentryAdapter: EnrichmentAdapter = {
  name: "sentry",
  apply: (tags) => {
    const s = sentryObj();
    if (!s) return false;
    try {
      if (typeof s.onLoad === "function") {
        // Der sichere Weg für Loader UND npm-Einbindung.
        s.onLoad(() => {
          const jetzt = sentryObj();
          if (jetzt) {
            try {
              schreibe(jetzt, tags);
            } catch {
              /* ein verlorenes Merkmal darf die Seite nichts kosten */
            }
          }
        });
        return true;
      }
      // Ältere Bündel ohne `onLoad`: nur direkt, wenn die Methode wirklich da
      // ist — genau die Prüfung, die den TypeError des Loader-Stubs verhindert.
      if (typeof s.setTags === "function" || typeof s.setTag === "function") {
        schreibe(s, tags);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },
  // Sentry überschreibt bei gleichem Schlüssel; kein Zustand bei uns.
  reset: () => {},
};
