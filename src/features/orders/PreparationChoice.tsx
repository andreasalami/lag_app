import { useId } from "react";
import type { KitchenState, PreparationMode } from "./types";

export function PreparationChoice({value,onChange,disabled=false}:{value:PreparationMode;onChange:(mode:PreparationMode)=>void;disabled?:boolean}) {
  const group=useId();
  return <fieldset disabled={disabled} className="my-4">
    <legend className="mb-2 font-semibold text-[var(--text-primary)]">Quando prepariamo il cibo?</legend>
    <div className="grid gap-2 sm:grid-cols-2">
      {([
        ['immediate','Prepara appena pago','Entra in cucina dopo il pagamento.'],
        ['deferred','Lo prenderò più tardi','Paga adesso. Mostra il QR in cucina quando vuoi iniziare la preparazione.'],
      ] as const).map(([mode,title,description])=><label key={mode} className={`cursor-pointer rounded-2xl border p-3 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-[var(--accent-primary)] ${value===mode?'border-[var(--accent-primary)] bg-[rgba(242,128,46,0.12)]':'border-[var(--surface-border)] bg-white/5'} ${disabled?'opacity-60':''}`}>
        <input className="sr-only" type="radio" name={group} checked={value===mode} onChange={()=>onChange(mode)}/>
        <span className="block text-sm font-semibold text-[var(--text-primary)]">{value===mode?'✓ ':''}{title}</span>
        <span className="mt-1 block text-xs text-[var(--text-secondary)]">{description}</span>
      </label>)}
    </div>
  </fieldset>;
}

export function kitchenMessage(state:KitchenState|undefined) {
  if(state==='dormant')return 'Pagato · Cibo da attivare. Mostra il QR in cucina quando vuoi far partire la preparazione, prima della chiusura del servizio.';
  if(state==='waiting')return 'Cibo attivato · In attesa di un posto in cucina. Non serve scansionare di nuovo il QR.';
  if(state==='active')return 'Il cibo è nella coda di preparazione.';
  if(state==='done')return 'Il cibo è stato ritirato.';
  return null;
}
