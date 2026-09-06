import {useEffect,useState} from "react";
import {Button} from "../../components/ui/Button";
import {recoveryLink} from "./orderRecovery";
import "./orderControls.css";
export function RecoveryCard({token,eventName,onBack}:{token:string;eventName:string;onBack:()=>void}) {
 const [image,setImage]=useState<string|null>(null);
 const [error,setError]=useState<string|null>(null);
 useEffect(()=>{
  let stopped=false;
  void import("qrcode").then(async ({default:QRCode})=>{
    const qr=await QRCode.toDataURL(recoveryLink(token),{width:420,margin:2});
    if(!stopped)setImage(qr);
  }).catch(()=>{if(!stopped)setError("Non riesco a preparare l’immagine. Riprova.");});
  return()=>{stopped=true;};
 },[token]);
 return <main className="pickup-selector mx-auto max-w-md px-4 py-6">
   <button className="order-quiet-action mb-4" onClick={onBack}>← Torna agli ordini</button>
   <div className="rounded-2xl bg-white p-5 text-center text-[#091422]">
    <p className="font-display text-3xl">LAG</p><h1 className="mt-2 text-xl">Recupera i miei ordini</h1>
    <p className="mt-2 text-sm">{eventName}</p>
    {image && <img className="mx-auto my-3 aspect-square w-full max-w-[280px]" src={image} alt="Il tuo codice personale per recuperare gli ordini"/>}
    <p className="text-sm font-semibold">Fai uno screenshot e conservalo.</p>
    <p className="mt-2 text-xs leading-relaxed">Apri questo QR per ritrovare gli ordini anche su un altro telefono. Tienilo per te: permette di accedere ai tuoi ordini.</p>
   </div>
   {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
   <Button className="mt-4 w-full" disabled={!image} onClick={()=>{
     if(!image)return;
     const link=document.createElement("a");link.href=image;link.download="LAG-recupero-ordini.png";link.click();
   }}>Scarica il QR di recupero</Button>
   <p className="mt-3 text-center text-xs text-[var(--text-secondary)]">Basta una copia per gli ordini di questo evento associati a questo dispositivo. Nessun account.</p>
 </main>;
}
