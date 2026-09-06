import { useState } from "react";
import { PreparationChoice, PreparationStatus } from "../features/orders/PreparationChoice";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import type { PreparationMode, KitchenState } from "../features/orders/types";

export function PreparationPreview() {
  const [mode,setMode]=useState<PreparationMode>('immediate');
  const [full,setFull]=useState(true);
  const [paid,setPaid]=useState(false);
  const [state,setState]=useState<KitchenState>('none');
  const [scanned,setScanned]=useState(false);
  return <main className="mx-auto max-w-lg px-4 py-6">
    <p className="mb-4 text-center text-xs text-[var(--text-secondary)]">Anteprima interattiva · dati dimostrativi · nessun pagamento reale</p>
    <h1 className="text-3xl">Subito o più tardi</h1>
    <p className="mt-2 text-sm text-[var(--text-secondary)]">Ordine #42 · Tavolo Girasole</p>
    <Card className="mt-5">
      <p>2 × Panino salamella</p><p>2 × Birra media</p>
      <p className="mt-3 border-t border-[var(--surface-border)] pt-3 font-semibold">Quantità già riservate nelle scorte</p>
      {!paid ? <><PreparationChoice value={mode} onChange={setMode}/>
        {full && mode==='immediate' && <p role="status" className="mb-3 text-sm text-[var(--state-warning)]">Cucina al completo · 100 / 100. La cassa attende un posto oppure concorda la preparazione successiva.</p>}
        <Button className="w-full" disabled={full && mode==='immediate'} onClick={()=>{setPaid(true);setState(mode==='deferred'?'dormant':'active');}}>Conferma pagamento di esempio</Button></> : <>
        <p className="mt-4 text-sm text-[var(--state-success)]">Pagamento registrato · Bevande ritirabili</p>
        <PreparationStatus state={state}/>
        {state==='dormant' && <Button className="mt-4 w-full" onClick={()=>setScanned(true)}>{scanned?'QR letto · Ordine #42':'Simula scansione QR in cucina'}</Button>}
        {scanned && state==='dormant' && <Button className="mt-2 w-full" onClick={()=>setState(full?'waiting':'active')}>Avvia preparazione del cibo</Button>}
      </>}
    </Card>
    <div className="mt-5 flex flex-wrap gap-2">
      <Button variant="ghost" onClick={()=>{setFull(value=>!value);if(full && state==='waiting')setState('active');}}>{full?'Simula un posto libero':'Simula cucina piena'}</Button>
      <Button variant="ghost" onClick={()=>{setPaid(false);setState('none');setScanned(false);}}>Ricomincia</Button>
    </div>
  </main>;
}
