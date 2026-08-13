import { createECDH } from "node:crypto";

const keys = createECDH("prime256v1");
keys.generateKeys();

console.log("WEB_PUSH_VAPID_PUBLIC_KEY=" + keys.getPublicKey().toString("base64url"));
console.log("WEB_PUSH_VAPID_PRIVATE_KEY=" + keys.getPrivateKey().toString("base64url"));
console.log("\nGenera queste chiavi una sola volta. Non commettere mai la chiave privata.");
