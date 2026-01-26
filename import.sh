#!/bin/bash
set -e

if [ ! -e $CERT ] ; then
    echo '$CERT not found'
    exit 1
elif [ -z $HOST ] ; then
    echo '$HOST not set'
    exit 1
fi

#last_date=`psql psny --tuples-only -A -c "select extract(epoch from max(run_date)) from train_track"`
last_date=$(date -u -d "2026-01-19" +%s)
today=$(date -d "00:00 UTC" +%s)
for ts in $(seq $last_date 86400 $today) ; do
    date=$(date -u -d @$ts +%Y-%m-%d)
    echo "Getting track data for $date"
    curl "https://$HOST/track?run_date=$date"  \
        --cert $CERT --cert-type p12 \
        | jq -r '(map(keys) | add | unique) as $cols | map(. as $row | $cols | map($row[.])) as $rows | $cols, $rows[] | @csv' \
        > track_import.csv

    echo "Getting route data for $date"
    curl "https://$HOST/route?run_date=$date" \
        --cert $CERT --cert-type p12 \
        | jq -r '(map(keys) | add | unique) as $cols | map(. as $row | $cols | map($row[.])) as $rows | $cols, $rows[] | @csv' \
        > route_import.csv
    # unique -> columns will be in alphabetical order
    
    echo "Importing for $date"
    psql psny -v ON_ERROR_STOP=1 <<EOF
truncate table train_track_import;
\copy train_track_import(canceled, loading_desc, operator, otp, passengers, run_date, stop, track, train_no, train_time) from 'track_import.csv' delimiter ',' csv header
insert into train_track (operator, run_date, train_no, train_time, stop, track, otp, canceled, passengers, loading_desc) select
    operator,
    (to_timestamp(run_date) at time zone 'UTC')::date,
    train_no,
    to_timestamp(train_time) at time zone 'America/New_York',
    stop,
    track,
    make_interval(secs => otp),
    canceled::boolean,
    passengers,
    loading_desc::jsonb
from train_track_import
on conflict (stop, run_date, operator, train_no) do update
set track = excluded.track, otp = excluded.otp, passengers = excluded.passengers, canceled = excluded.canceled, loading_desc = excluded.loading_desc;

truncate table train_route_import;
\copy train_route_import(consist, destination, operator, origin, route, run_date, train_no) from 'route_import.csv' delimiter ',' csv header
insert into train_route (operator, run_date, train_no, route, origin, destination, consist) select
    operator,
    (to_timestamp(run_date) at time zone 'UTC')::date,
    train_no,
    route,
    origin,
    destination,
    consist::jsonb
from train_route_import
on conflict (run_date, operator, train_no) do update
set consist = excluded.consist;
\q
EOF
    if [ $ts -ne $today ] ; then
        echo "Deleting data for $date"
        curl "https://$HOST/delete?run_date=$date" \
            --cert $CERT --cert-type p12
        echo " rows deleted"
    fi
done