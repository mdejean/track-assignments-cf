create table if not exists train_track (
    operator varchar,
    run_date date,
    train_no varchar,
    train_time timestamp with time zone,
    stop varchar,
    track varchar,
    otp interval,
    canceled boolean,
    passengers int,
    loading_desc jsonb,
    primary key (stop, run_date, operator, train_no)
) without oids;

create table train_route (
    operator varchar,
    run_date date,
    train_no varchar,
    route varchar,
    origin varchar,
    destination varchar,
    consist jsonb,
    primary key (run_date, operator, train_no)
) without oids;

create table train_track_import (
    operator varchar,
    run_date int,
    train_no varchar,
    train_time int,
    stop varchar,
    track varchar,
    otp int,
    canceled varchar,
    passengers int,
    loading_desc varchar,
    primary key (stop, run_date, operator, train_no)
);

create table if not exists train_route_import (
    operator varchar,
    run_date int,
    train_no varchar,
    route varchar,
    origin varchar,
    destination varchar,
    consist varchar,
    primary key (run_date, operator, train_no)
);