/**
 * Adapter: PostHog.
 *
 * Bequemer als Clarity in jeder Hinsicht — mit genau einer Asymmetrie, die man
 * kennen muss:
 *
 * SCHREIBEN ist sicher, auch bevor PostHog geladen hat. Das offizielle Snippet
 * legt `window.posthog` als Warteschlangen-Stub an, der unter anderem `register`
 * puffert und nach dem Laden abspielt. Ein `register()` überschreibt bei
 * gleichem Schlüssel (`this.props[prop] = to`) — anders als Clarity hängt hier
 * nichts an, wir dürfen also jederzeit mit dem vollen Satz nachfassen.
 *
 * LESEN ist es nicht. Die Stubs haben kein `return`; `get_session_id()` liefert
 * dort `undefined` statt einer Kennung. Für die Sitzungskennung muss PostHog
 * deshalb wirklich initialisiert sein — erkennbar an `__loaded === true`. Das
 * Feld steht in der ausgelieferten Typdeklaration, ist aber undokumentiert, also
 * behandeln wir es als Innenleben und prüfen defensiv.
 *
 * Warum die Merkmale als Super-Properties und nicht am Replay direkt: PostHogs
 * Replay-Rohdaten (`$snapshot`) bekommen keine Super-Properties angehängt — die
 * Property-Zusammenstellung kehrt dafür früh zurück. Das Filtern von
 * Aufzeichnungen läuft über die normalen Events der Sitzung, verknüpft per
 * `$session_id`. Deshalb MUSS `register()` clientseitig laufen; serverseitig
 * gesetzte Eigenschaften brächten für die Replay-Filterung nichts.
 */

import type { EnrichmentAdapter } from "./enrichment.ts";

interface PostHogLike {
  register?: (properties: Record<string, unknown>, days?: number) => void;
  get_session_id?: () => string;
  sessionRecordingStarted?: () => boolean;
  __loaded?: boolean;
}

function posthogObj(): PostHogLike | null {
  try {
    const ph = (globalThis as { posthog?: unknown }).posthog;
    return ph && typeof ph === "object" ? (ph as PostHogLike) : null;
  } catch {
    return null;
  }
}

/**
 * Ist PostHog nicht nur vorhanden, sondern fertig initialisiert?
 *
 * Nur dann liefern die Getter echte Werte. `__SV` taugt zur Unterscheidung
 * nicht — das setzt der Stub auch. Aussagekräftig ist `__loaded`.
 */
function istGeladen(ph: PostHogLike): boolean {
  return ph.__loaded === true;
}

/**
 * Die PostHog-Sitzungskennung, wenn sie belastbar ist.
 *
 * Drei Bedingungen, und alle drei sind nötig: PostHog ist initialisiert (sonst
 * liefert der Stub `undefined` und die Instanz einen leeren String), es läuft
 * tatsächlich eine Aufzeichnung (sonst zeigt ein späterer Link ins Leere), und
 * die Kennung ist nicht leer.
 *
 * Bewusst NUR die Kennung, nicht `get_session_replay_url()`: Dessen Adressform
 * steht nirgends in der Doku, nur im Quelltext, und sie leitet den Host aus
 * `api_host` ab — hinter einer eigenen Proxy-Route, wie sie Trackdolphin-Kunden
 * üblicherweise fahren, kommt dabei ein falscher Host heraus. Die Adresse bauen
 * wir serverseitig aus Region und Projekt, wo wir beides sicher kennen.
 */
export function readPostHogSessionId(): string | null {
  const ph = posthogObj();
  if (!ph || !istGeladen(ph)) return null;
  try {
    if (typeof ph.sessionRecordingStarted === "function" && !ph.sessionRecordingStarted()) return null;
    if (typeof ph.get_session_id !== "function") return null;
    const id = ph.get_session_id();
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export const posthogAdapter: EnrichmentAdapter = {
  name: "posthog",
  apply: (tags) => {
    const ph = posthogObj();
    // Der Stub puffert `register` — für das Schreiben reicht die Typprüfung.
    if (!ph || typeof ph.register !== "function") return false;
    try {
      ph.register(tags);
      return true;
    } catch {
      return false;
    }
  },
  // PostHog überschreibt bei jedem Aufruf; es gibt keinen Zustand zu verwerfen.
  reset: () => {},
};
