import { DurableObject } from "cloudflare:workers";

import {
  getCiphers,
  createCipheriv
} from "node:crypto";

export class NJTToken extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.token_payload = env.NJT_TOKEN_PAYLOAD;
        this.token_key = env.NJT_TOKEN_KEY;
        this.token_api = env.NJT_TOKEN_API;
    }
    
    async get_token() {
        if (Date.now() - (this.ctx.storage.kv.get("token_date") || 0) > 3 * 60 * 60 * 1000) {
            let cipher = createCipheriv('aes-192-ecb', this.token_key, '');
            let encrypted = cipher.update("timestamp==" + new Date().toISOString() + this.token_payload, 'utf8', 'latin1');
            encrypted += cipher.final('latin1');
            let token_fd = new FormData();
            token_fd.append("BaseInfo", btoa(encrypted));
            let token_req = await fetch(this.token_api,
                {
                    "method": "POST",
                    "body": token_fd,
                });
            if (token_req.status != 200) {
                console.log(`NJT Token Got HTTP ${token_req.status}`);
            } else {
                let token_resp = await token_req.json();
                this.ctx.storage.kv.put("token", token_resp.UserToken);
                this.ctx.storage.kv.put("token_date", Date.now());
                console.log("Got new token " + token_resp.UserToken);
                return token_resp.UserToken;
            }
        }
        return this.ctx.storage.kv.get("token");
    }
}