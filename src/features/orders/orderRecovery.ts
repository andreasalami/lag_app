const KEY_PREFIX="lag:recovery:";
export const validRecoveryToken=(token:unknown):token is string=>typeof token==="string" && /^[A-Za-z0-9_-]{43}$/.test(token);
export function readRecoveryToken(eventId:string):string|null {
 try {const token=localStorage.getItem(KEY_PREFIX+eventId);return validRecoveryToken(token)?token:null;}catch{return null;}
}
export function saveRecoveryToken(eventId:string,token:string) {
 if(!validRecoveryToken(token)) return false;
 try{localStorage.setItem(KEY_PREFIX+eventId,token);return localStorage.getItem(KEY_PREFIX+eventId)===token;}catch{return false;}
}
export function getOrCreateRecoveryToken(eventId:string):string {
 const existing=readRecoveryToken(eventId);if(existing)return existing;
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 const token=btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
 if(!saveRecoveryToken(eventId,token))throw new Error("recovery_storage_unavailable");
 return token;
}
export async function recoveryOrderQr(token:string,requestId:string) {
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(token),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const bytes=new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(requestId.toLowerCase())));
 const hex=[...bytes].map(byte=>byte.toString(16).padStart(2,"0")).join("");
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export function recoveryLink(token:string) {
 return `${location.origin}${import.meta.env.BASE_URL}#ordina?recupero=${encodeURIComponent(token)}`;
}
