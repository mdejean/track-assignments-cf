import { DurableObject } from "cloudflare:workers";

export class TrainState extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        ctx.blockConcurrencyWhile(async () => {
            this.track_occupancy = ctx.storage.kv.get("track_occupancy") || {};
            
            const schema_sql = `
            create table if not exists train_track (
                operator varchar,
                run_date int,
                train_no varchar,
                train_time int,
                stop varchar,
                track varchar,
                otp int,
                canceled int,
                passengers int,
                loading_desc varchar, -- json
                primary key (stop, run_date, operator, train_no)
            ) without rowid;
            
            create table if not exists train_route (
                operator varchar,
                run_date int,
                train_no varchar,
                route varchar,
                origin varchar,
                destination varchar,
                consist varchar, -- json
                primary key (run_date, operator, train_no)
            ) without rowid;
            `;
            //TODO: schema migrations
            
            ctx.storage.sql.exec(schema_sql);
        });
    }
    
    async add_track(trains) {
        let write = 0;
        let read = 0;
        for (let t of trains) {
            let route_result = this.ctx.storage.sql.exec(`
                insert into train_route (operator, run_date, train_no, route, origin, destination, consist)
                values                  (       ?,          ?,        ?,     ?,      ?,           ?,       ?)
                on conflict do update set
                    consist = excluded.consist,
                    route = excluded.route,
                    origin = excluded.origin,
                    destination = excluded.destination
                where (excluded.consist is not null and excluded.consist is distinct from train_route.consist)
                or (excluded.operator = 'Amtrak' and excluded.route != 'AMTK')
            `, t.operator, t.run_date, t.train_no, t.route, t.origin, t.destination, t.consist);
            
            let conflict_clause = `
                on conflict do update set
                    track = coalesce(excluded.track, train_track.track),
                    otp = excluded.otp,
                    canceled = excluded.canceled,
                    passengers = coalesce(excluded.passengers, train_track.passengers),
                    loading_desc = coalesce(excluded.loading_desc, train_track.loading_desc)
                where  (excluded.track is not null and excluded.track is distinct from train_track.track)
                    or (excluded.otp is not null and excluded.otp is distinct from train_track.otp)
                    or (excluded.canceled is not null and excluded.canceled is distinct from train_track.canceled)
                    or (excluded.passengers is not null and excluded.passengers is distinct from train_track.passengers)
                    or (excluded.loading_desc is not null and excluded.loading_desc is distinct from train_track.loading_desc)`;
            if (t?.do_update == 'once') {
                conflict_clause = `
                    on conflict do update set
                        track = coalesce(train_track.track, excluded.track),
                        otp = excluded.otp,
                        canceled = excluded.canceled,
                        passengers = coalesce(train_track.passengers, excluded.passengers),
                        loading_desc = coalesce(train_track.loading_desc, excluded.loading_desc)
                    where (train_track.track is null and excluded.track is not null)
                        or (train_track.passengers is null and excluded.passengers is not null)
                        or (train_track.loading_desc is null and excluded.loading_desc is not null)`;
            }
            
            let track_result = this.ctx.storage.sql.exec(`
                insert into train_track (  operator,   run_date,   train_time,   train_no,   stop,   track,   otp,   canceled,   passengers,   loading_desc)
                                 values (         ?,          ?,            ?,          ?,      ?,       ?,     ?,          ?,            ?,              ?)
                ` + conflict_clause,     t.operator, t.run_date, t.train_time, t.train_no, t.stop, t.track, t.otp, t.canceled, t.passengers, t.loading_desc);
            
            write += route_result.rowsWritten + track_result.rowsWritten;
            read += route_result.rowsRead + track_result.rowsRead;
            
            if (t.track && (t.stop == 'NY' || t.stop == 'NYK' || t.stop == 'NYP')) {
                // going to just ignore the possiblity that trains could go out of schedule order on a track
                if ((this.track_occupancy?.[t.track]?.train_time || 0) <= t.train_time) {
                    this.track_occupancy[t.track] = t;
                }
            }
        }

        this.ctx.storage.kv.put("track_occupancy", this.track_occupancy);

        return [write, read];
    }
    
    async get_last_train() {
        return this.track_occupancy;
    }
    
    async get_train_track(run_date) {
        return this.ctx.storage.sql.exec("select * from train_track where run_date = ?", run_date).toArray();
    }
    
    async get_train_route(run_date) {
        return this.ctx.storage.sql.exec("select * from train_route where run_date = ?", run_date).toArray();
    }
    
    // 5GB is lots, but still better to keep it small
    async delete_data(run_date) {
        return this.ctx.storage.sql.exec("delete from train_track where run_date = ?;", run_date).rowsWritten
            + this.ctx.storage.sql.exec("delete from train_route where run_date = ?;", run_date).rowsWritten;
    }
}