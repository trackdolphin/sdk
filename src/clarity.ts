/**
 * Adapter: Microsoft Clarity.
 *
 * Die Eigenheit, die alles andere bestimmt: `clarity("set", key, value)`
 * ÜBERSCHREIBT NICHT — es hängt an. Zwei Aufrufe mit demselben Schlüssel ergeben
 * in Clarity ein Array mit beiden Werten, und die Sitzung erscheint danach unter
 * BEIDEN Filterwerten. Deshalb hier: jeder Schlüssel genau einmal, mit seinem
 * endgültigen Wert. Merkmale, deren Wert noch nicht feststeht, lässt
 * `buildTags()` weg, statt sie vorläufig zu setzen.
 *
 * Zweite Eigenheit: Ein neu gesetztes Merkmal erscheint erst nach 30 Minuten bis
 * 2 Stunden in der Filterliste des Dashboards; in den Ereignisdetails einer
 * einzelnen Aufzeichnung ist es sofort sichtbar. Das ist Clarity-seitig so
 * vorgesehen und nichts, was wir beschleunigen könnten.
 */

import type { EnrichmentAdapter } from "./enrichment.ts";

type ClarityFn = (command: string, ...args: unknown[]) => void;

/**
 * Clarity taucht spät auf, wenn ein Einwilligungsbanner es zurückhält. Der
 * Schnipsel legt `window.clarity` zwar sofort als Warteschlangen-Stub an, aber
 * nur, wenn er überhaupt im Dokument steht. Wird er erst nach der Zustimmung
 * eingefügt, existiert beim `init()` noch nichts. Also ein paar Versuche mit
 * wachsendem Abstand — und dann Schluss, damit kein Timer die Seite überlebt.
 */
const RETRY_DELAYS_MS = [0, 500, 2000, 5000];

/** Welche Schlüssel schon gesetzt wurden — siehe Anhäng-Semantik oben. */
const setKeys = new Set<string>();

let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clarityFn(): ClarityFn | null {
  try {
    const fn = (globalThis as { clarity?: unknown }).clarity;
    return typeof fn === "function" ? (fn as ClarityFn) : null;
  } catch {
    // Zugriff auf `globalThis` kann in exotischen Sandboxes werfen.
    return null;
  }
}

/**
 * Clarity bitten, diese Sitzung sicher aufzuzeichnen.
 *
 * Clarity behält bis zu 100.000 Aufzeichnungen je Projekt und Tag; darüber
 * fängt es an zu stichproben. `upgrade` hebt eine Sitzung rückwirkend aus dem
 * Sparmodus heraus und schützt sie davor — dokumentierte API. Damit lässt sich
 * erzwingen, dass ausgerechnet die Sitzungen erhalten bleiben, in denen Geld
 * geflossen ist.
 *
 * Bewusst NICHT standardmäßig an: Der Aufruf erhöht die Aufzeichnungstiefe, und
 * mehr Daten zu erheben ist eine Entscheidung des Shopbetreibers, nicht unsere.
 */
export function upgradeClarity(reason: string): boolean {
  const fn = clarityFn();
  if (!fn) return false;
  try {
    fn("upgrade", reason);
    return true;
  } catch {
    return false;
  }
}

function applyClarity(tags: Record<string, string>, attempt = 0): boolean {
  const fn = clarityFn();

  if (fn) {
    for (const [key, value] of Object.entries(tags)) {
      if (setKeys.has(key)) continue;
      try {
        fn("set", key, value);
        setKeys.add(key);
      } catch {
        // Clarity kann intern werfen; ein verlorenes Merkmal ist der Preis.
      }
    }
    return true;
  }

  const delay = RETRY_DELAYS_MS[attempt + 1];
  if (delay === undefined || typeof setTimeout !== "function") return false;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    applyClarity(tags, attempt + 1);
  }, delay);
  return false;
}

export const clarityAdapter: EnrichmentAdapter = {
  name: "clarity",
  apply: (tags) => applyClarity(tags),
  reset: () => {
    setKeys.clear();
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  },
};
