import { useEffect, useRef, useState, type ReactNode } from "react";
import { PickupSelection } from "../features/orders/PickupSelection";
import { isPickupSelectionValid, type PickupItem } from "../features/orders/pickupQuantities";

type View = "ordine" | "qr" | "ritiro" | "recupero";
type DemoItem = PickupItem & { price: number; station: string; icon: "beer" | "food" | "drink" };
const INITIAL_ITEMS: DemoItem[] = [
  { id: "beer", name: "Birra media", quantity: 10, delivered_quantity: 0, price: 4.5, station: "Birre", icon: "beer" },
  { id: "sandwich", name: "Panino salamella", quantity: 2, delivered_quantity: 0, price: 5, station: "Secondi", icon: "food" },
  { id: "fries", name: "Patatine fritte", quantity: 1, delivered_quantity: 0, price: 3.5, station: "Contorni", icon: "food" },
  { id: "cola", name: "Cola", quantity: 2, delivered_quantity: 0, price: 3, station: "Bar", icon: "drink" },
];
const VIEWS: { id: View; title: string; description: string; number: string }[] = [
  { id: "ordine", title: "Ordina con semplicità", description: "Menu, riepilogo e una conferma.", number: "01" },
  { id: "qr", title: "Il QR sempre a portata", description: "Cosa ritirare, senza cercare.", number: "02" },
  { id: "ritiro", title: "Un po’ adesso, il resto dopo", description: "L’addetto sceglie le quantità.", number: "03" },
  { id: "recupero", title: "Conserva i tuoi ordini", description: "Una sola copia per tutto l’evento.", number: "04" },
];
const euro = (amount: number) => new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(amount);

function Icon({ kind }: { kind: DemoItem["icon"] }) {
  return <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind === "beer" ? <><path d="M5 8h11v12H5zM16 9h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3M8 11v6M12 11v6"/><path d="M5 8a3 3 0 0 1 0-6 3 3 0 0 1 4 0 3 3 0 0 1 5 1 3 3 0 0 1 2 5"/></> : kind === "food" ? <><path d="M4 10a8 7 0 0 1 16 0H4ZM3 14h18M4 18h16M9 6h.01M14 6h.01"/></> : <><path d="m5 7 2 14h10l2-14ZM4 7h16M13 7l2-5h4"/></>}</svg>;
}

function TinyArrow() { return <span aria-hidden="true">↗</span>; }
function SectionLabel({ children }: { children: ReactNode }) { return <p className="preview-label">{children}</p>; }

export function OrderExperiencePreview() {
  const initialView = new URLSearchParams(window.location.search).get("vista") as View;
  const [view, setView] = useState<View>(VIEWS.some((entry) => entry.id === initialView) ? initialView : "ritiro");
  const [items, setItems] = useState<DemoItem[]>(INITIAL_ITEMS);
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [station, setStation] = useState("Birre");
  const [paid, setPaid] = useState(true);
  const [alias, setAlias] = useState("Tavolo Girasole");
  const [cart, setCart] = useState<Record<string, number>>({ beer: 10, sandwich: 2, fries: 1, cola: 2 });
  const [review, setReview] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastItems, setLastItems] = useState<DemoItem[] | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [recoveryImage, setRecoveryImage] = useState<string | null>(null);
  const [downloadMessage, setDownloadMessage] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftError, setDraftError] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const deviceRef = useRef<HTMLDivElement>(null);
  const recoveryRef = useRef<HTMLDivElement>(null);
  const navigated = useRef(false);

  useEffect(() => {
    if (!navigated.current) return;
    // Keep the recovery card fully visible for a single phone screenshot.
    const target = view === "recupero" ? recoveryRef.current : deviceRef.current;
    target?.scrollIntoView({ block: "start" });
  }, [view]);

  useEffect(() => {
    // This key contains demo data only and is completely separate from the
    // live order history. The recovery preview intentionally has no backend.
    try {
      const stored = JSON.parse(localStorage.getItem("lag:preview-order-draft-v1") ?? "null");
      if (stored && typeof stored.alias === "string" && stored.cart && typeof stored.cart === "object"
        && INITIAL_ITEMS.every((item) => Number.isInteger(stored.cart[item.id]) && stored.cart[item.id] >= 0 && stored.cart[item.id] <= 99)) {
        setAlias(stored.alias.slice(0, 32)); setCart(stored.cart); setDraftRestored(true);
      }
    } catch { setDraftError(true); }
    setDraftReady(true);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    try { localStorage.setItem("lag:preview-order-draft-v1", JSON.stringify({ cart, alias })); setDraftError(false); }
    catch { setDraftError(true); }
  }, [cart, alias, draftReady]);

  useEffect(() => {
    let cancelled = false;
    void import("qrcode").then(async ({ default: QRCode }) => {
      const qr = await QRCode.toDataURL("LAG-PREVIEW-ORDER-42-NOT-A-REAL-ORDER", { width: 480, margin: 2 });
      const recovery = await QRCode.toDataURL("LAG-PREVIEW-RECOVERY-NOT-A-REAL-CREDENTIAL", { width: 480, margin: 2 });
      if (!cancelled) { setQrImage(qr); setRecoveryImage(recovery); }
    }).catch(() => { if (!cancelled) setNotice("Anteprima QR non disponibile. Ricarica la pagina."); });
    return () => { cancelled = true; };
  }, []);

  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const remaining = items.reduce((sum, item) => sum + item.quantity - item.delivered_quantity, 0);
  const delivered = items.reduce((sum, item) => sum + item.delivered_quantity, 0);
  const stationItems = items.filter((item) => item.station === station && item.quantity > item.delivered_quantity);
  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  const cartTotal = INITIAL_ITEMS.reduce((sum, item) => sum + item.price * (cart[item.id] ?? 0), 0);
  const activeView = VIEWS.find((entry) => entry.id === view)!;

  function navigate(next: View) {
    navigated.current = true;
    setView(next); setNotice(null); setReview(false); setDownloadMessage(null);
    const url = new URL(window.location.href); url.searchParams.set("vista", next); window.history.replaceState(null, "", url);
  }

  function deliverSelection() {
    if (!paid || !isPickupSelectionValid(stationItems, selection)) return;
    const selected = stationItems.filter((item) => (selection[item.id] ?? 0) > 0);
    if (selected.length === 0) return;
    setLastItems(items);
    setItems(items.map((item) => item.station === station ? { ...item, delivered_quantity: item.delivered_quantity + (selection[item.id] ?? 0) } : item));
    setNotice(`${selected.map((item) => `${selection[item.id]} × ${item.name}`).join(", ")} ${selected.reduce((sum, item) => sum + selection[item.id], 0) === 1 ? "consegnato" : "consegnati"}.`);
    setSelection({});
  }

  function submitDemoOrder() {
    if (!alias.trim() || cartCount === 0) return;
    setItems(INITIAL_ITEMS.filter((item) => cart[item.id] > 0).map((item) => ({ ...item, quantity: cart[item.id], delivered_quantity: 0 })));
    setPaid(false); setSelection({}); setLastItems(null); navigate("qr");
  }

  async function downloadRecovery() {
    if (!recoveryImage) return;
    try {
      const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 1160;
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas_unavailable");
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, 900, 1160);
      ctx.textAlign = "center"; ctx.fillStyle = "#091422"; ctx.font = "bold 55px sans-serif"; ctx.fillText("I MIEI ORDINI · LAG", 450, 110);
      ctx.font = "28px sans-serif"; ctx.fillText("Una copia per tutto l’evento", 450, 166);
      const img = new Image(); img.src = recoveryImage; await img.decode(); ctx.drawImage(img, 150, 220, 600, 600);
      ctx.font = "30px sans-serif"; ctx.fillText("Conserva questa immagine.", 450, 900);
      ctx.font = "25px sans-serif"; ctx.fillText("Il codice servirà per ritrovare i tuoi ordini.", 450, 950);
      ctx.fillStyle = "#a54908"; ctx.font = "bold 24px sans-serif"; ctx.fillText("ANTEPRIMA · CODICE DIMOSTRATIVO NON VALIDO", 450, 1055);
      const anchor = document.createElement("a"); anchor.download = "LAG-anteprima-recupero.png"; anchor.href = canvas.toDataURL("image/png"); anchor.click();
      setDownloadMessage("Immagine preparata. Controlla i download del browser.");
    } catch { setDownloadMessage("Puoi conservare la scheda facendo uno screenshot."); }
  }

  function resetDemo() {
    setItems(INITIAL_ITEMS); setPaid(true); setSelection({}); setLastItems(null); setNotice(null);
    setCart({ beer: 10, sandwich: 2, fries: 1, cola: 2 }); setAlias("Tavolo Girasole"); setReview(false); setStation("Birre");
  }

  return (
    <main className="preview-shell px-4 pb-12 pt-6 sm:px-8 lg:px-12">
      <header className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-5">
        <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-primary)] font-display text-lg text-[var(--text-on-accent)]">LAG</span><span className="text-sm font-semibold">L’Agro ai Giovani <span className="ml-2 hidden font-normal text-[var(--text-secondary)] sm:inline">/ Il nuovo modo di ordinare</span></span></div>
        <div className="flex items-center gap-4"><span className="rounded-full border border-[var(--accent-primary)]/30 px-3 py-1.5 text-[10px] uppercase tracking-widest text-[var(--accent-primary)]">Anteprima · dati di esempio</span><button type="button" className="order-quiet-action" onClick={resetDemo}>Ricomincia</button></div>
      </header>
      <div className="mx-auto mb-8 mt-8 max-w-[1280px]"><SectionLabel>Meno passaggi. Più tempo per la serata.</SectionLabel><h1 className="preview-heading mt-3 max-w-3xl text-3xl sm:text-5xl">Ordina. Ritira quando vuoi.<br/><span className="text-[var(--accent-primary)]">Il resto rimane sul tuo QR.</span></h1></div>
      <div className="mx-auto grid max-w-[1280px] items-start gap-7 md:grid-cols-[220px_minmax(0,440px)] lg:grid-cols-[240px_minmax(0,440px)_minmax(200px,1fr)] lg:gap-10">
        <nav aria-label="Schermate dell’anteprima" className="grid grid-cols-2 gap-2 md:grid-cols-1 md:gap-3">
          {VIEWS.map((entry) => <button key={entry.id} type="button" aria-current={view === entry.id ? "page" : undefined} onClick={() => navigate(entry.id)} className={`rounded-2xl border p-4 text-left transition-colors ${view === entry.id ? "border-[var(--accent-primary)]/40 bg-[rgba(242,128,46,0.07)]" : "border-transparent hover:bg-white/5"}`}><span className={`font-mono text-[10px] ${view === entry.id ? "text-[var(--accent-primary)]" : "text-[var(--text-secondary)]"}`}>{entry.number}</span><strong className="mt-2 block text-sm leading-snug">{entry.title}</strong><span className="mt-1 hidden text-xs leading-relaxed text-[var(--text-secondary)] md:block">{entry.description}</span></button>)}
        </nav>
        <div ref={deviceRef} className="preview-device w-full max-w-[440px] justify-self-center">
          <div className="flex items-center justify-between border-b border-white/10 px-5 py-4"><span className="font-display text-lg">LAG<span className="ml-2 font-sans text-xs text-[var(--text-secondary)]">{view === "ritiro" ? "Staff · Ritiro" : "La tua serata"}</span></span><span className="flex items-center gap-1.5 text-[10px] text-[var(--text-secondary)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)]"/>Anteprima</span></div>
          <div className="preview-device-body">
            {view === "ordine" && <>
              <SectionLabel>{review ? "Un ultimo controllo" : "Il menu della serata"}</SectionLabel>
              <h2 className="mt-2 text-3xl">{review ? "Tutto giusto?" : "Cosa ti va?"}</h2>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{review ? "Controlla quantità e totale. Pagherai in cassa." : "Scegli qui, paga in cassa e ritira con il QR."}</p>
              {draftRestored && !review && <p className="mt-3 text-xs text-[var(--state-success)]">✓ Abbiamo ritrovato il tuo carrello.</p>}
              {review && <label className="mt-5 block"><span className="text-sm font-semibold">Un nome per il tuo ordine</span><input className="field mt-2 min-h-12 w-full !px-3 !text-base" maxLength={32} value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="Es. Tavolo Girasole"/><span className="mt-1 block text-xs text-[var(--text-secondary)]">Basta un soprannome. Non serve un account.</span></label>}
              <div className="mt-5">{INITIAL_ITEMS.filter((item) => !review || cart[item.id] > 0).map((item) => <div key={item.id} className="preview-line flex items-center gap-3 py-4"><span className="preview-product-icon"><Icon kind={item.icon}/></span><div className="min-w-0 flex-1"><p className="text-sm font-semibold">{item.name}</p><p className="mt-1 font-mono text-xs text-[var(--text-secondary)]">{euro(item.price)}</p></div><div className="order-stepper order-stepper--compact"><button type="button" aria-label={`Rimuovi ${item.name} dal carrello`} disabled={!cart[item.id]} className="order-stepper-button" onClick={() => setCart({ ...cart, [item.id]: Math.max(0, cart[item.id] - 1) })}>−</button><span className="min-w-5 text-center font-mono text-sm">{cart[item.id]}</span><button type="button" aria-label={`Aggiungi ${item.name} al carrello`} disabled={cart[item.id] >= 99} className="order-stepper-button" onClick={() => setCart({ ...cart, [item.id]: Math.min(99, cart[item.id] + 1) })}>+</button></div></div>)}</div>
              {review && <details className="mt-4"><summary className="preview-disclosure">Aggiungi una nota · facoltativo</summary><textarea className="field min-h-20 w-full !p-3" placeholder="Es. senza cipolla" maxLength={300}/></details>}
              <div className="mt-5 rounded-2xl bg-[var(--surface-solid)] p-4"><div className="mb-4 flex items-end justify-between"><span className="text-sm text-[var(--text-secondary)]">{cartCount} articoli</span><strong className="font-mono text-xl">{euro(cartTotal)}</strong></div><button type="button" disabled={!cartCount || (review && !alias.trim())} className="preview-primary" onClick={() => review ? submitDemoOrder() : setReview(true)}>{review ? "Conferma e vai in cassa" : "Controlla ordine"}<span aria-hidden="true">→</span></button><p className={`mt-3 text-center text-[10px] ${draftError ? "text-[var(--state-error)]" : "text-[var(--text-secondary)]"}`}>{draftError ? "Salvataggio sul dispositivo non disponibile." : "✓ Il carrello si salva da solo"}</p></div>
              {review && <button type="button" className="order-quiet-action mt-2 w-full" onClick={() => setReview(false)}>← Torna al menu</button>}
            </>}

            {view === "qr" && <>
              <div className="flex items-center justify-between"><SectionLabel>Il tuo ordine</SectionLabel><span className="order-badge" data-tone={paid ? "success" : "pending"}>{!paid ? "Da pagare" : remaining === 0 ? "Tutto ritirato" : delivered > 0 ? "Ritiro parziale" : "Pagato"}</span></div>
              <div className="mt-2 flex items-end justify-between"><div><h2 className="font-mono text-5xl font-semibold tracking-tight">#42</h2><p className="mt-2 text-sm text-[var(--text-secondary)]">{alias}</p></div><span className="pb-1 font-mono text-lg">{euro(total)}</span></div>
              <div className="mt-5 rounded-2xl bg-white p-3 text-center">{qrImage ? <img src={qrImage} alt="QR dimostrativo dell’ordine 42" className="mx-auto aspect-square w-full max-w-[248px]"/> : <p className="py-20 text-sm text-slate-600">Preparo il QR…</p>}<p className="pb-2 text-xs font-semibold text-[#152a46]">{paid ? "Lo stesso QR, a ogni ritiro." : "Mostra questo QR alla cassa."}</p></div>
              <div className="mt-5 flex items-center justify-between"><h3 className="text-base">{paid ? "Ti resta da ritirare" : "Il tuo ordine"}</h3><span className="text-xs text-[var(--text-secondary)]">{paid ? remaining : items.reduce((sum, item) => sum + item.quantity, 0)} articoli</span></div>
              <div className="mt-1">{items.map((item) => <div key={item.id} className="preview-line flex items-center justify-between gap-3 py-3"><div><p className={`text-sm ${item.quantity === item.delivered_quantity ? "text-[var(--text-secondary)] line-through" : "font-semibold"}`}>{item.name}</p><p className="mt-1 text-[10px] text-[var(--text-secondary)]">{item.station}{item.delivered_quantity > 0 ? ` · ${item.delivered_quantity} già ritirati` : ""}</p></div><span className={`font-mono text-lg ${item.quantity === item.delivered_quantity ? "text-[var(--state-success)]" : "text-[var(--accent-primary)]"}`}>{item.quantity === item.delivered_quantity ? "✓" : item.quantity - item.delivered_quantity}</span></div>)}</div>
              <button type="button" className="preview-secondary mt-5 flex w-full items-center justify-center gap-2" onClick={() => navigate("recupero")}>Conserva i miei ordini <TinyArrow/></button>
              <p className="mt-2 text-center text-[10px] text-[var(--text-secondary)]">Per ritrovarli anche se cancelli i dati del browser.</p>
              <details className="mt-4"><summary className="preview-disclosure">I miei ordini · 1</summary><p className="rounded-xl bg-white/5 p-3 text-sm">#42 · {alias} · {euro(total)}</p></details>
              <button type="button" className="order-quiet-action w-full" onClick={() => navigate("ordine")}>+ Ordina ancora</button>
            </>}

            {view === "ritiro" && <>
              <div className="flex items-center justify-between"><SectionLabel>Ordine #42</SectionLabel><span className="order-badge" data-tone={paid ? "success" : "pending"}>{paid ? "Pagato" : "Da pagare"}</span></div>
              <h2 className="mt-2 text-2xl">{alias}</h2><p className="mt-1 text-sm text-[var(--text-secondary)]">Anche una parte adesso. Il resto quando vuole.</p>
              <fieldset className="preview-stations">
                <legend>Postazione di esempio</legend>
                <div className="preview-station-options">
                  {["Birre", "Secondi", "Contorni", "Bar"].map((name) => (
                    <label key={name} className="preview-station-option">
                      <input type="radio" name="preview-station" value={name} checked={station === name} onChange={() => { setStation(name); setSelection({}); setNotice(null); }}/>
                      <span>{name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {notice && <div role="status" className="preview-notice mb-4"><strong className="block text-sm text-[#9ed3a8]">✓ {notice}</strong><p className="mt-1 text-xs text-[var(--text-secondary)]">Le quantità rimaste sono già aggiornate.</p>{lastItems && <button type="button" className="order-quiet-action mt-1" onClick={() => { setItems(lastItems); setLastItems(null); setNotice("Ritiro annullato. Quantità ripristinate."); }}>Annulla questo ritiro</button>}</div>}
              {!paid ? <p className="rounded-xl border border-[var(--accent-primary)]/40 p-4 text-sm">L’ordine deve essere pagato in cassa prima del ritiro.</p> : stationItems.length > 0 ? <PickupSelection items={stationItems} selection={selection} onChange={setSelection} onConfirm={deliverSelection}/> : <div className="rounded-2xl border border-[#6fa97a]/30 p-6 text-center"><span className="text-3xl text-[#9ed3a8]">✓</span><h3 className="mt-3 text-lg">Tutto ritirato qui</h3><p className="mt-2 text-sm text-[var(--text-secondary)]">{remaining ? "Gli altri prodotti restano nelle rispettive postazioni." : "Questo ordine è completo."}</p></div>}
            </>}

            {view === "recupero" && <>
              <button type="button" className="order-quiet-action mb-3" onClick={() => navigate("qr")}>← Torna al mio QR</button>
              <SectionLabel>Una copia per tutta la serata</SectionLabel><h2 className="mt-2 text-3xl">I tuoi ordini,<br/>sempre con te.</h2><p className="mb-5 mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">Fai uno screenshot di questa scheda e conservalo. Basta una volta per tutto l’evento.</p>
              <div ref={recoveryRef} className="preview-recovery"><span className="font-display text-3xl">LAG</span><h3 className="mt-1 font-sans text-lg font-bold">Recupera i miei ordini</h3><p className="mt-1 text-xs text-slate-500">L’Agro ai Giovani · Il tuo evento</p>{recoveryImage && <img src={recoveryImage} alt="Esempio di QR per recuperare lo storico, non valido" className="mx-auto mt-3 aspect-square w-full max-w-[230px]"/>}<p className="mt-2 text-sm font-semibold">Conserva questa immagine.</p><p className="mt-1 text-xs leading-relaxed text-slate-500">Ti servirà se cancelli i dati del browser<br/>o cambi telefono. Tienila per te.</p><p className="mt-4 border-t border-slate-200 pt-3 font-mono text-[9px] uppercase tracking-widest text-[#a54908]">Anteprima · codice non valido</p></div>
              <button type="button" className="preview-primary mt-5" disabled={!recoveryImage} onClick={() => void downloadRecovery()}>Scarica l’immagine <span aria-hidden="true">↓</span></button>
              <p className="mt-3 text-center text-xs leading-relaxed text-[var(--text-secondary)]">Oppure usa lo screenshot del telefono.<br/>Nessun account e nessuna password da ricordare.</p>
              {downloadMessage && <p role="status" className="mt-3 text-center text-xs text-[#9ed3a8]">{downloadMessage}</p>}
            </>}
          </div>
        </div>
        <aside className="md:col-start-2 lg:col-start-auto">
          <div className="rounded-2xl border border-white/10 p-5"><SectionLabel>Da provare nell’anteprima</SectionLabel><h2 className="mt-3 text-xl">{view === "ritiro" ? "2 birre. Due tocchi." : activeView.title}</h2><p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">{view === "ritiro" ? "Premi 2, poi Consegna 2 articoli. Le 8 birre rimaste saranno ancora disponibili. Apri la vista del cliente per vedere il risultato." : view === "qr" ? "Il QR viene prima di tutto. Subito sotto trovi i prodotti rimasti, con il nome della postazione. Il totale pagato non cambia con i ritiri." : view === "ordine" ? "Modifica il carrello, controlla e conferma. Puoi anche ricaricare la pagina: la bozza dimostrativa viene salvata sul dispositivo." : "Un tocco su Conserva i miei ordini, poi uno screenshot. Il download è un’alternativa; i passaggi del sistema dipendono dal telefono."}</p>
            {view === "ritiro" && <button type="button" className="preview-secondary mt-4 w-full" onClick={() => navigate("qr")}>Vedi il QR del cliente →</button>}
            {!paid && <button type="button" className="preview-secondary mt-4 w-full" onClick={() => setPaid(true)}>Simula pagamento in cassa</button>}
          </div>
          <div className="mt-5 px-1"><SectionLabel>Come funziona</SectionLabel><ul className="mt-4 space-y-3 text-xs leading-relaxed text-[var(--text-secondary)]"><li><span className="mr-2 text-[var(--accent-primary)]">01</span>L’addetto conferma solo ciò che consegna.</li><li><span className="mr-2 text-[var(--accent-primary)]">02</span>Quantità indipendenti per ogni prodotto.</li><li><span className="mr-2 text-[var(--accent-primary)]">03</span>Un solo QR per tutti i ritiri.</li></ul></div>
          <p className="mt-6 border-t border-white/10 pt-4 text-[11px] leading-relaxed text-[var(--text-secondary)]">Questa anteprima usa solo dati di esempio. Non crea ordini reali. Il recupero dal server è rappresentato graficamente: il codice dimostrativo non recupera dati. Nella versione operativa ogni addetto mantiene i permessi della propria area.</p>
        </aside>
      </div>
    </main>
  );
}
