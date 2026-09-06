import { describe, it, expect } from "vitest";
import {readPendingOrder,savePendingOrder,clearPendingOrder,type PendingOrderRequest} from "./pendingOrder";
function storage() {
 const data=new Map<string,string>();
 return {get length(){return data.size;},key:(n:number)=>[...data.keys()][n]??null,
 getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
}
const request:PendingOrderRequest={requestId:"123e4567-e89b-42d3-a456-426614174000",qrToken:"123e4567-e89b-42d3-a456-426614174001",eventId:"123e4567-e89b-42d3-a456-426614174002",alias:"Test",notes:"",createdAt:"2026-09-05T08:00:00Z",items:[{id:"123e4567-e89b-42d3-a456-426614174003",name:"Birra",category:"bevande",subcategory:"birre",qty:2,price:4,allergens:[]}]};
describe("pending order journal",()=>{
 it("preserves deferred preparation across a retry",()=>{const db=storage();const later={...request,preparationMode:'deferred' as const};savePendingOrder(later,db);expect(readPendingOrder(db)?.preparationMode).toBe('deferred');});
 it("rejects an invalid preparation preference in persisted data",()=>{const db=storage();db.setItem('lag:pending-order:'+request.requestId,JSON.stringify({...request,preparationMode:'invalid'}));expect(readPendingOrder(db)).toBeNull();});
 it("restores the exact identity and payload after reload",()=>{const db=storage();expect(savePendingOrder(request,db)).toBe(true);expect(readPendingOrder(db)).toEqual(request);});
 it("keeps independent requests from multiple tabs",()=>{const db=storage();const second={...request,requestId:"123e4567-e89b-42d3-a456-426614174004",createdAt:"2026-09-05T08:01:00Z"};savePendingOrder(request,db);savePendingOrder(second,db);clearPendingOrder(request.requestId,db);expect(readPendingOrder(db)).toEqual(second);});
 it("reports storage failure before an order may be sent",()=>{expect(savePendingOrder(request,{...storage(),setItem:()=>{throw new Error("quota");}})).toBe(false);});
 it("does not let a damaged entry hide another recoverable request",()=>{const db=storage();db.setItem("lag:pending-order:broken","{");savePendingOrder(request,db);expect(readPendingOrder(db)).toEqual(request);});
});
