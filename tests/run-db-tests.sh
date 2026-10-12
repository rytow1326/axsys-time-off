#!/usr/bin/env bash
# Runs the migration + behaviour tests against a scratch Postgres database.
# Usage: PGHOST=... PGPORT=... PGUSER=postgres ./tests/run-db-tests.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
DB=axsys_timeoff_test
psql -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
psql -q -v ON_ERROR_STOP=1 -d $DB -f "$DIR/tests/supabase_stubs.sql"
# pg_net is provided by the stub schema here
for f in "$DIR/supabase/migrations/"*.sql; do
  sed '/create extension if not exists pg_net/d' "$f" | psql -q -v ON_ERROR_STOP=1 -d $DB
done
for t in db_tests db_tests_signup; do
  psql -q -t -o /dev/null -v ON_ERROR_STOP=1 -d $DB -f "$DIR/tests/$t.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: NOTICE:  //'
done
psql -q -d postgres -c "drop database $DB"
