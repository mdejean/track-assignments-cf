import { DurableObject } from "cloudflare:workers";

export class TrainState extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => {
            this.sql = ctx.storage.sql;
            const schema_sql = `        
            create table if not exists train_track (
                operator varchar,
                train_time int,
                train_no varchar,
                stop varchar,
                track varchar,
                otp int,
                canceled int,
                primary key (train_time, operator, train_no, stop)
            ) without rowid;
            
            create table if not exists train_route (
                operator varchar,
                train_time int,
                train_no varchar,
                route varchar,
                origin varchar,
                destination varchar,
                consist blob, -- jsonb
                primary key (train_time, operator, train_no)
            ) without rowid;
            `
            this.sql.exec(schema_sql);
        });
    }
    
    async add_track(do_update, trains) {
        let write = 0;
        let read = 0;
        for (let t of trains) {
            // train_route never updates
            let route_result = this.sql.exec(`
                insert into train_route (operator, train_time, train_no, route, origin, destination, consist)
                values                  (       ?,          ?,        ?,     ?,      ?,           ?,       ?)
                on conflict do nothing`, t.operator, t.train_time, t.train_no, t.route, t.origin, t.destination, t.consist);
            
            let track_result = this.sql.exec(`
                insert into train_track (operator, train_time, train_no, stop, track, otp, canceled)
                                 values (       ?,          ?,        ?,    ?,     ?,   ?,        ?)
                on conflict do ` + (
                    !do_update ? "nothing" :
                    `update set track = coalesce(excluded.track, train_track.track), otp = excluded.otp, canceled = excluded.canceled
                     where (excluded.track is not null and excluded.track is distinct from train_track.track)
                        or (excluded.otp is not null and excluded.otp is distinct from train_track.otp)
                        or (excluded.canceled is not null and excluded.canceled is distinct from train_track.canceled)`
                ),                       t.operator, t.train_time, t.train_no, t.stop, t.track, t.otp, t.canceled);
            
            write += route_result.rowsWritten + track_result.rowsWritten;
            read += route_result.rowsRead + track_result.rowsRead;
        }
        
        return [write, read]
    }
    
    async get_current() {
        let now = Date.now() / 1000 - 60 * 60 * 10;
        let res = this.sql.exec(`
            select * from train_track where (train_time, track) in (
                select max(train_time), track from train_track
                where track is not null
                and train_time > ?
                group by track
            )`, now);
        console.log(res.rowsRead + " rows read");
        return res.toArray();
    }
}