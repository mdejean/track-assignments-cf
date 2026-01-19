import { DurableObject, env } from "cloudflare:workers";

import {
  getCiphers,
  createCipheriv
} from "node:crypto";

export class NJTToken extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.token_date = this.ctx.storage.kv.get("token_date");
        this.token = this.ctx.storage.kv.get("token");
    }
    
    async get_token() {
        if (Date.now() - (this.token_date || 0) > 3 * 60 * 60 * 1000) {
            let cipher = createCipheriv('aes-192-ecb', env.NJT_TOKEN_KEY, '');
            let encrypted = cipher.update("timestamp==" + new Date().toISOString() + env.NJT_TOKEN_PAYLOAD, 'utf8', 'latin1');
            encrypted += cipher.final('latin1');
            let token_fd = new FormData();
            token_fd.append("BaseInfo", btoa(encrypted));
            let token_req = await fetch(env.NJT_TOKEN_API,
                {
                    "method": "POST",
                    "body": token_fd,
                    "signal": AbortSignal.timeout(5000),
                });
            if (token_req.status != 200) {
                console.log(`NJT Token Got HTTP ${token_req.status}`);
            } else {
                let token_resp = await token_req.json();
                this.token = token_resp.UserToken;
                this.ctx.storage.kv.put("token", this.token);
                this.token_date = Date.now();
                this.ctx.storage.kv.put("token_date", this.token_date);
                console.log("Got new token " + token_resp.UserToken);
                return token_resp.UserToken;
            }
        }
        return this.token;
    }
}