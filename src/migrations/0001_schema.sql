-- GHG accounting schema (PostgreSQL 16; also runs on 15 for CI).
-- All measured/computed values are stored as exact reduced rationals
-- (numerator bigint, denominator bigint positive). The application performs
-- every addition/multiplication with bigint rationals; SQL SUM is never used
-- on accounting values, so recomputation is bit-identical regardless of
-- execution order.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- Master data
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
    code        text PRIMARY KEY,
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE emission_sources (
    site_code   text NOT NULL REFERENCES sites(code),
    code        text NOT NULL,
    name        text NOT NULL,
    fuel_key    text NOT NULL,          -- matches factor library fuel/activity key
    scope       smallint NOT NULL CHECK (scope IN (1, 2)),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_code, code)
);

-- ---------------------------------------------------------------------------
-- Factor library (append-only, immutable once published)
-- ---------------------------------------------------------------------------

CREATE TABLE factor_versions (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    version       text NOT NULL UNIQUE,
    published_at  timestamptz NOT NULL DEFAULT now(),
    published_by  text,
    note          text
);

-- Fuel physical properties belonging to a factor version. Density / NCV are
-- versioned *because they are factors*: updating them is a factor-library
-- change and must show up as such in a restatement decomposition.
CREATE TABLE fuel_properties (
    factor_version_id integer NOT NULL REFERENCES factor_versions(id),
    fuel_key          text NOT NULL,
    density_num       bigint NOT NULL,   -- kg / m3
    density_den       bigint NOT NULL CHECK (density_den > 0),
    ncv_num           bigint,            -- net calorific value, GJ / tonne
    ncv_den           bigint CHECK (ncv_den IS NULL OR ncv_den > 0),
    PRIMARY KEY (factor_version_id, fuel_key),
    CHECK (density_num >= 0),
    CHECK ((ncv_num IS NULL) = (ncv_den IS NULL)),
    CHECK (ncv_num IS NULL OR ncv_num >= 0)
);

CREATE TABLE emission_factors (
    id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    factor_version_id integer NOT NULL REFERENCES factor_versions(id) ON DELETE CASCADE,
    fuel_key           text NOT NULL,
    gas                text NOT NULL CHECK (gas IN ('CO2', 'CH4', 'N2O')),
    scope              smallint NOT NULL CHECK (scope IN (1, 2)),
    value_num          bigint NOT NULL,  -- mass of gas
    value_den          bigint NOT NULL CHECK (value_den > 0),
    factor_unit        text NOT NULL,    -- per activity unit, e.g. 'kg/GJ', 'kg/m3', 'kg/kWh'
    valid_from         date NOT NULL,
    valid_to           date NOT NULL,
    CHECK (valid_from <= valid_to),
    CHECK (value_num >= 0)
);

-- Applicability periods of the same gas/fuel inside one version must not
-- overlap (closed-open date ranges; adjacent periods are allowed).
ALTER TABLE emission_factors
    ADD CONSTRAINT emission_factors_no_overlap
    EXCLUDE USING gist (
        factor_version_id WITH =,
        fuel_key WITH =,
        gas WITH =,
        scope WITH =,
        daterange(valid_from, valid_to, '[]') WITH &&
    );

CREATE INDEX emission_factors_lookup
    ON emission_factors (factor_version_id, fuel_key, gas, scope);

-- ---------------------------------------------------------------------------
-- Global warming potential sets (AR5, AR6, ...)
-- ---------------------------------------------------------------------------

CREATE TABLE gwp_sets (
    id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code          text NOT NULL UNIQUE,  -- e.g. AR5, AR6
    name          text NOT NULL,
    published_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gwp_values (
    gwp_set_id integer NOT NULL REFERENCES gwp_sets(id) ON DELETE CASCADE,
    gas         text NOT NULL CHECK (gas IN ('CO2', 'CH4', 'N2O')),
    value_num   bigint NOT NULL,
    value_den   bigint NOT NULL CHECK (value_den > 0),
    PRIMARY KEY (gwp_set_id, gas),
    CHECK (value_num >= 0)
);

-- ---------------------------------------------------------------------------
-- Activity data with single-level correction pointers
-- ---------------------------------------------------------------------------

CREATE TABLE activity_records (
    id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    record_no             text NOT NULL UNIQUE,
    site_code             text NOT NULL REFERENCES sites(code),
    source_code           text NOT NULL,
    month                 date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    fuel_key              text NOT NULL,
    scope                 smallint NOT NULL CHECK (scope IN (1, 2)),
    quantity_num          bigint NOT NULL,
    quantity_den          bigint NOT NULL CHECK (quantity_den > 0),
    unit                  text NOT NULL,
    is_correction         boolean NOT NULL DEFAULT false,
    supersedes_record_no  text REFERENCES activity_records(record_no),
    created_at            timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (site_code, source_code)
        REFERENCES emission_sources(site_code, code),
    CHECK (quantity_num >= 0)
);

-- A record can be corrected at most once. Because corrections may only point
-- at not-yet-corrected records, this partial unique index is also the
-- concurrency guard: two simultaneous corrections of the same record_no race
-- here and exactly one commits.
CREATE UNIQUE INDEX activity_one_correction_per_record
    ON activity_records (supersedes_record_no)
    WHERE supersedes_record_no IS NOT NULL;

CREATE INDEX activity_lookup
    ON activity_records (site_code, source_code, month);
CREATE INDEX activity_created
    ON activity_records (created_at);

-- Named activity-data cut-off points (a cut is just an immutable timestamp;
-- the visible record set at cut c is derived, see engine SQL).
CREATE TABLE activity_cuts (
    id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label       text,
    as_of       timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (as_of)
);

-- ---------------------------------------------------------------------------
-- Monthly close and disclosure snapshots (the materialized calibers)
-- ---------------------------------------------------------------------------

CREATE TABLE close_periods (
    id                 integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    month              date NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
    is_company_wide    boolean NOT NULL DEFAULT true,
    site_code          text REFERENCES sites(code),
    cut_id integer NOT NULL REFERENCES activity_cuts(id),
    factor_version_id integer NOT NULL REFERENCES factor_versions(id),
    gwp_set_id integer NOT NULL REFERENCES gwp_sets(id),
    status             text NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running', 'closed')),
    started_at         timestamptz NOT NULL DEFAULT now(),
    closed_at          timestamptz,
    CHECK (is_company_wide OR site_code IS NOT NULL),
    UNIQUE (month, is_company_wide, site_code)
);

CREATE TABLE snapshot_rows (
    close_id integer NOT NULL REFERENCES close_periods(id) ON DELETE CASCADE,
    site_code    text NOT NULL,
    source_code  text NOT NULL,
    month        date NOT NULL,
    scope        smallint NOT NULL,
    gas          text NOT NULL CHECK (gas IN ('CO2', 'CH4', 'N2O', 'CO2E')),
    value_num    bigint NOT NULL,   -- tonnes
    value_den    bigint NOT NULL CHECK (value_den > 0),
    PRIMARY KEY (close_id, site_code, source_code, month, scope, gas)
);

-- Each leaf result stored in a snapshot carries its factor lineage, so a
-- disclosure number can be explained without recomputing anything.
CREATE TABLE snapshot_lineage (
    close_id integer NOT NULL REFERENCES close_periods(id) ON DELETE CASCADE,
    site_code          text NOT NULL,
    source_code        text NOT NULL,
    month              date NOT NULL,
    scope              smallint NOT NULL,
    gas                text NOT NULL CHECK (gas IN ('CO2', 'CH4', 'N2O')),
    record_no          text NOT NULL REFERENCES activity_records(record_no),
    factor_id integer NOT NULL REFERENCES emission_factors(id),
    activity_qty_num   bigint NOT NULL,  -- quantity expressed in factor unit
    activity_qty_den   bigint NOT NULL,
    gas_mass_num       bigint NOT NULL,  -- tonnes of this gas from this record
    gas_mass_den       bigint NOT NULL,
    PRIMARY KEY (close_id, record_no, gas)
);

-- ---------------------------------------------------------------------------
-- Base-year restatement log
-- ---------------------------------------------------------------------------

CREATE TABLE base_year_flags (
    base_year        integer PRIMARY KEY,
    needs_recalc     boolean NOT NULL,
    marked_at        timestamptz NOT NULL DEFAULT now(),
    reason           text NOT NULL
);

CREATE TABLE restatement_notes (
    id               integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    base_year        integer NOT NULL,
    caliber_a        jsonb NOT NULL,
    caliber_b        jsonb NOT NULL,
    old_total_num    bigint NOT NULL,
    old_total_den    bigint NOT NULL,
    new_total_num    bigint NOT NULL,
    new_total_den    bigint NOT NULL,
    change_ratio_num bigint NOT NULL,   -- |new-old| / |old|
    change_ratio_den bigint NOT NULL,
    threshold_num    bigint NOT NULL,
    threshold_den    bigint NOT NULL,
    triggered        boolean NOT NULL,
    note             text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now()
);
