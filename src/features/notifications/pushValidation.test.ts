import {describe,it,expect} from "vitest";
import {validPushEndpoint,validPushKeys} from "../../../supabase/functions/_shared/pushValidation";
describe("push endpoint boundaries",()=>{
 it.each(["https://fcm.googleapis.com/fcm/send/test-device","https://updates.push.services.mozilla.com/wpush/v2/test-device","https://web.push.apple.com/test-device","https://wns1.notify.windows.com/w/?token=test-device"])("accepts provider %s",url=>expect(validPushEndpoint(url)).toBe(true));
 it.each(["https://127.0.0.1/private","https://fcm.googleapis.com.evil.test/x","https://fcm.googleapis.com@evil.test/x","https://fcm.googleapis.com:8443/x","http://web.push.apple.com/x","https://web.push.apple.com/x#fragment","https://fcm.googleapis.com\\@evil.test/x"])("rejects %s",url=>expect(validPushEndpoint(url)).toBe(false));
 it("rejects malformed encryption keys",()=>{expect(validPushKeys("A".repeat(87),"B".repeat(22))).toBe(false);expect(validPushKeys("invalid","invalid")).toBe(false);});
});
