// Piccoli helper per le API del browser che possono fallire a runtime.

/** Link interno che rispetta il base path di GitHub Pages (`/lag_app/`). */
export function appHref(hash = "") {
  return `${import.meta.env.BASE_URL}${hash}`;
}

// localStorage può lanciare eccezioni (cookie bloccati in Safari, quota piena,
// navigazione privata): queste funzioni non interrompono mai il rendering.
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return localStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

export function removeStorage(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage non disponibile: non c'è niente da rimuovere.
  }
}

const scripts = new Map<string, Promise<void>>();

/**
 * Carica uno script esterno una sola volta per pagina. Errore o timeout
 * liberano la cache, così un nuovo tentativo riprova davvero.
 */
export function loadScriptOnce(src: string, isReady: () => boolean, timeoutMs = 15_000): Promise<void> {
  if (isReady()) return Promise.resolve();
  const pending = scripts.get(src);
  if (pending) return pending;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      scripts.delete(src);
      reject(new Error(`script_unavailable: ${src}`));
    };
    const timer = window.setTimeout(fail, timeoutMs);
    script.src = src;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (isReady()) resolve();
      else fail();
    };
    script.onerror = fail;
    document.head.append(script);
  });
  scripts.set(src, promise);
  return promise;
}

/**
 * Chiama `refresh` ogni `intervalMs` e quando la scheda torna visibile, mai a scheda
 * nascosta: niente richieste da telefoni in tasca. Restituisce la funzione di pulizia
 * da chiamare nel cleanup dell'effetto.
 */
export function pollWhileVisible(refresh: () => void, intervalMs: number) {
  const run = () => {
    if (document.visibilityState === "visible") refresh();
  };
  const timer = window.setInterval(run, intervalMs);
  document.addEventListener("visibilitychange", run);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", run);
  };
}
