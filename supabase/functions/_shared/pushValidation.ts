// Keep this provider list aligned with public.valid_push_endpoint in the schema.
export function validPushEndpoint(endpoint: string): boolean {
  if(endpoint.length<28 || endpoint.length>2048 || /[\s\\#]/.test(endpoint)) return false;
  try {
    const url=new URL(endpoint);
    return url.protocol==="https:" && !url.username && !url.password && !url.port && !url.hash
      && (new Set(["fcm.googleapis.com","updates.push.services.mozilla.com","web.push.apple.com"]).has(url.hostname)
        || /^[a-z0-9-]+\.notify\.windows\.com$/.test(url.hostname))
      && url.pathname.length>1;
  } catch {return false;}
}
export function validPushKeys(p256dh: string, auth: string): boolean {
  if(!/^[A-Za-z0-9_-]{87}$/.test(p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(auth)) return false;
  try {
    const decode=(value:string)=>atob(value.replace(/-/g,"+").replace(/_/g,"/"));
    const point=decode(p256dh);
    return point.length===65 && point.charCodeAt(0)===4 && decode(auth).length===16;
  } catch {return false;}
}
