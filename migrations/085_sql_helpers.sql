CREATE OR REPLACE FUNCTION utc_text(at timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') $$;

CREATE OR REPLACE FUNCTION utc_date_text(at timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') $$;

CREATE OR REPLACE FUNCTION utc_today_text() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') $$;

CREATE OR REPLACE FUNCTION utc_ts(value text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT CASE WHEN value IS NULL OR btrim(value) = '' THEN NULL
    ELSE (replace(substr(value, 1, 19), 'T', ' ') || '+00')::timestamptz END $$;

CREATE OR REPLACE FUNCTION days_between(a text, b text) RETURNS double precision
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT EXTRACT(EPOCH FROM (utc_ts(a) - utc_ts(b))) / 86400.0 $$;
