"use strict";
/**
 * track assignments
 */

export { TrainState } from "./train_state";
export { NJTToken } from "./njt_token";

async function fetch_njt(db, env) {
    let token = await env.NJTTOKEN.getByName("token").get_token();
    
    console.log(token);
    
    let fd = new FormData();
    fd.append("token", token);
    fd.append("station", "NY");
    
    const tzname = 
        (new Intl.DateTimeFormat(
            "en-US",
            {timeZone: "America/New_York", timeZoneName: "longOffset"})
        ).formatToParts(new Date()) // assume chaos happens during daylight savings (all trains displayed in current timezone)
        .filter((t) => t.type == "timeZoneName")
        [0].value;
    
    let resp = await fetch(env.NJT_API,
        {
            "method": "POST",
            "body": fd
        });
    
    if (resp.status != 200) {
        let t = await resp.text();
        console.log(`NJT Got HTTP ${resp.status} : ${t}`);
        return [];
    } else {
        let j = await resp.json();
        return j["ITEMS"].map((t) =>
            ({
                "stop": "NY",
                "operator": (t["TRAIN_ID"][0] == 'A') ? "Amtrak" : "NJT",
                "train_time":  Date.parse(t["SCHED_DEP_DATE"] + " " + tzname) / 1000,
                "train_no": ((t["TRAIN_ID"][0] == 'A') ? t["TRAIN_ID"].substring(1) : t["TRAIN_ID"]),
                "route": t["LINEABBREVIATION"],
                "origin": "NY",
                "destination": t["DESTINATION"].replace(/-SEC|&#9992/g,"").trim(),
                "track": t["TRACK"] || null,
                "consist": null,
                "otp": t["SEC_LATE"],
                "canceled": t["STATUS"].startsWith("CANCEL"),
            })
        );
    }
}

async function fetch_amtrak(db, env) {
    const date_in_ny = (new Date(Date.now() -
            Number.parseInt(
                (new Intl.DateTimeFormat(
                    "en-US",
                    {timeZone: "America/New_York", timeZoneName: "longOffset"})
                ).formatToParts(new Date())
                .filter((t) => t.type == "timeZoneName")
                [0].value[5] //literally all this to get 5 or 4
            ) * 60 * 60 * 1000
        )).toISOString().substring(0, 10);
    
    let resp = await fetch(env.AMTRAK_API + "NYP?departure-date=" + date_in_ny,
        {
            "method": "GET",
            "referer": env.AMTRAK_REFERER,
        });

    if (resp.status != 200) {
        let t = await resp.text();
        console.log(`Amtrak Got HTTP ${resp.status} : ${t}`);
        return [];
    } else {
        let j = await resp.json();
        let trains = j["data"].map(
            (t) => {
                let train_time = Date.parse(t.departure?.schedule?.dateTime || t.arrival?.schedule?.dateTime || t.travelService?.date) / 1000;
                
                return {
                    "stop": "NY",
                    "operator": "Amtrak",
                    "train_time": train_time,
                    "train_no": t.travelService?.number,
                    "route": t.travelService?.name?.description,
                    "origin": t.travelService?.origin?.code,
                    "destination": t.travelService?.destination?.code,
                    "track": t.departure?.track?.number || t.arrival?.track?.number,
                    "consist": null,
                    "otp": train_time - Date.parse(t.departure?.statusInfo?.dateTime || t.arrival?.statusInfo?.dateTime) / 1000,
                    "canceled": (t.departure?.statusInfo?.status || t.arrival?.statusInfo?.status || "ON_TIME").upper().startsWith("CANC"),
                }
            }
        );
        return trains;
    }
}

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        
        if (url.pathname == '/getCurrent') {
            let db = env.TRAINSTATE.getByName("the only instance");
            let trains = await db.get_current();
            console.log(trains);
            return Response.json(trains);
        }
    },

    // The scheduled handler is invoked at the interval set in our wrangler.jsonc's
    // [[triggers]] configuration.
    async scheduled(event, env, ctx) {
        let db = env.TRAINSTATE.getByName("the only instance");
        //let trains = [];
        // todo: parallel
        // let trains = await fetch_amtrak(db, env)
        let trains = await fetch_njt(db, env);
        
        for (let t of trains) {
            console.log(`${t.operator} ${t.train_no} : ${t.train_time} on track ${t.track}`);
        }

        let rows = await db.add_track(true, trains);
        console.log(`${rows[0]} written, ${rows[1]} read`)
    },
};
