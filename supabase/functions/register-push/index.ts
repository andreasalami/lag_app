import { handlePublicRequest } from "../_shared/publicGateway.ts";
Deno.serve((request: Request) => handlePublicRequest(request, "push"));
