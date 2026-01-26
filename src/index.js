"use strict";
/**
 * track assignments
 */

export { TrainState } from "./train_state";
export { NJTToken } from "./njt_token";


// Now doing the whole fancy token thingy (more security theater)
async function fetch_njt(db, env) {
    // run date changes at 8AM GMT (4AM EDT / 3AM EST) when no NJT trains depart
    function get_run_date(d) {
        let t = (Date.parse(d) / 1000 - 8 * 60 * 60) | 0;
        let days = (t / (60 * 60 * 24)) | 0;
        return days * 60 * 60 * 24;
    }
    
    let token = await env.NJTTOKEN.getByName("token").get_token();
    
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
            "body": fd,
            "signal": AbortSignal.timeout(5000),
        });
    
    if (resp.status != 200) {
        let t = await resp.text();
        console.log(`NJT Got HTTP ${resp.status} : ${t}`);
        return [0, 0];
    } else {
        let j = await resp.json();
        return db.add_track(
            j["ITEMS"].map((t) =>
                ({
                    "stop": "NY",
                    "operator": (t["TRAIN_ID"][0] == 'A') ? "Amtrak" : "NJT",
                    "train_time": Date.parse(t["SCHED_DEP_DATE"] + " " + tzname) / 1000,
                    "run_date": get_run_date(t["SCHED_DEP_DATE"] + " " + tzname),
                    "train_no": ((t["TRAIN_ID"][0] == 'A') ? t["TRAIN_ID"].substring(1) : t["TRAIN_ID"]),
                    "route": t["LINEABBREVIATION"],
                    "origin": "NY",
                    "destination": t["DESTINATION"].replace(/-SEC|&#9992/g,"").trim(),
                    "track": t["TRACK"] || null,
                    "consist": null,
                    "otp": t["SEC_LATE"],
                    "canceled": t["STATUS"].startsWith("CANCEL"),
                    "do_update": "yes",
                })
            )
        );
    }
}

// for this one we do lots of stations and get passenger counts - can we keep it under 10 ms?
async function fetch_lirr(db, env) {
    let promises = [];
    for (let stop of ['ATL', 'HPA', 'LIC', 'GCT', 'WDD', 'NYK', 'JAM', '0NY']) {
        let req = fetch(env.LIRR_API + stop + "?include_passed=true&hours=0.33",
            {
                "method": "GET",
                "headers": new Headers({
                    "Accept-Version": "3.0",
                    "x-api-key": env.API_KEY,
                }),
                "signal": AbortSignal.timeout(5000),
            });
        promises.push(req.then(handle_req, async (reason) => Promise.resolve(reason)));
        async function handle_req(res) {
            if (res.status != 200) {
                console.log(`LIRR for {stop} Got HTTP ${res.status} : ${t}`);
                return Promise.resolve([]);
            }
            let trains = [];
            for (let train of await res.json()) {
                const stop_index = train.details?.stops?.findIndex(s => s.code == stop);
                const stop_details = train.details?.stops?.at(stop_index);
                const prev_stop_details = train.details?.stops?.at(stop_index - 1);
                const next_stop_details = train.details?.stops?.at(stop_index + 1);
                const event_details = train.details?.events?.find(s => s.code == stop);
                const cars = train?.consist?.cars || [];
                
                // don't update after train arrives at next stop
                if (next_stop_details?.stop_status == 'DEPARTED') continue;
                // don't update before train arrives at prev stop
                if (prev_stop_details?.stop_status == 'EN_ROUTE') continue;
                // don't update anything after train leaves stop inbound (also works for terminals!)
                if (train?.details?.direction == 'W' && stop_details?.stop_status == 'DEPARTED') continue;
                
                let passengers = null;
                let loading_desc = null;
                
                let do_update = null;
                if (train?.details?.direction == 'E'
                    // Record the passenger count only once, the first non-null count after the train leaves
                    && stop_details?.stop_status == 'DEPARTED'
                    // Don't record loading at the eastbound terminal (yes, it will show DEPARTED there)
                    && train?.details?.stops?.at(-1)?.code != stop) {
                    do_update = 'once';
                    passengers = cars.reduce((a, c) => a + (c?.passengers || 0), 0) || null;
                    if (!passengers) {
                        loading_desc = cars.map(c => (c?.loading != 'NO_DATA') ? c?.loading : '');
                        if (loading_desc.every(d => !d)) {
                            loading_desc = null;
                        }
                    }
                } else if (train?.details?.direction == 'W' && stop_details?.stop_status == 'EN_ROUTE') {
                    // Update the passenger count until the train arrives
                    // TODO: evaluate the number of wasted writes this causes
                    do_update = 'yes';
                    passengers = cars.reduce((a, c) => a + (c?.passengers || 0), 0) || null;
                    if (!passengers) {
                        loading_desc = cars.map(c => (c?.loading != 'NO_DATA') ? c?.loading : '');
                        if (loading_desc.every(d => !d)) {
                            loading_desc = null;
                        }
                    }
                } else {
                    passengers = null;
                    loading_desc = null;
                    do_update = 'yes'; // update, but not the loading
                }
                
                trains.push({
                    "stop": stop,
                    "operator": train.railroad,
                    "run_date": Date.parse(train.run_date) / 1000,
                    // not really sure why I used *event* time here, but they seem to differ ~1 minute
                    "train_time": event_details.sched_time || stop_details.sched_time,
                    "train_no": train.train_num,
                    "route": train.details?.branch,
                    "origin": train.details?.stops?.at(0)?.code,
                    "destination": train.details?.stops?.at(-1)?.code,
                    "track": stop_details?.sign_track || event_details?.act_track,
                    // other stuff can just be looked up from car no
                    "consist": cars.length ? JSON.stringify(cars.map((c) => c.number)) : null,
                    "otp": stop_details?.act_time ? stop_details.sched_time - stop_details.act_time : null,
                    "canceled": train?.status?.canceled,
                    "passengers": passengers,
                    "loading_desc": loading_desc ? JSON.stringify(loading_desc) : null,
                    "do_update": do_update,
                });
            }
            
            return trains;
        }
    }
    
    let results = await Promise.all(promises);
    return db.add_track(results.flat(1));
}

// Killed by Akamai WAF
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
                    "run_date": Date.parse(t.travelService?.date) / 1000,
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
        return db.add_track(trains);
    }
}

export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        
        if (url.pathname == '/last') {
            let db = env.TRAINSTATE.getByName("the only instance");
            let trains = await db.get_last_train();
            return Response.json(trains);
        } else if (req.cf?.tlsClientAuth?.certVerified == 'SUCCESS' && ['/track', '/route', '/delete', '/check_cert'].includes(url.pathname)) {
            let db = env.TRAINSTATE.getByName("the only instance");
            let run_date = Date.parse(url.searchParams.get("run_date")) / 1000;
            if (url.pathname == '/check_cert') {
                return Response.json(req.cf?.tlsClientAuth);
            } else if (url.pathname == '/track') {
                return Response.json(await db.get_train_track(run_date));
            } else if (url.pathname == '/route') {
                return Response.json(await db.get_train_route(run_date));
            } else if (url.pathname == '/delete') {
                return Response.json(await db.delete_data(run_date));
            }
        } else {
            return new Response(null, {status: 404});
        }
    },

    // The scheduled handler is invoked at the interval set in our wrangler.jsonc's
    // [[triggers]] configuration.
    async scheduled(event, env, ctx) {
        let db = env.TRAINSTATE.getByName("the only instance");
        // let trains = await fetch_amtrak(db, env)
        let done = [
            fetch_njt(db, env).then(njt => {
                    console.log(`NJT ${njt[0]} written, ${njt[1]} read`);
                }
            ),
            fetch_lirr(db, env).then(lirr => {
                    console.log(`LIRR ${lirr[0]} written, ${lirr[1]} read`);
                }
            ),
        ];
        ctx.waitUntil(Promise.all(done));
    },
};
