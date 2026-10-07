-- Commit-boundary based cut visibility.
--
-- Background: a "now" cut used to store a wall-clock as_of timestamp and the
-- effective record set was derived via created_at <= as_of. But created_at is
-- frozen at the *start* of the importing transaction (DEFAULT now()), while the
-- rows become visible to other sessions only when that transaction *commits*.
-- A long import transaction (several hundred rows, several batches in flight)
-- therefore starts before the cut's timestamp yet commits after the cut: its
-- rows were invisible when the cut was queried the first time and became
-- "visible by the timestamp" afterwards — the same cut returned different
-- totals on re-query. A close taken mid-import hit the same skew between its
-- REPEATABLE READ snapshot (the disclosed number) and any later recomputation
-- (the timestamp predicate on a fresh snapshot).
--
-- Fix: each import transaction is an immutable *import batch* carrying a
-- monotonic commit-serial id. A "committed" cut (a createCutNow() / close cut)
-- freezes the set of batch ids visible to its own snapshot — exactly the
-- batches committed before the cut's snapshot. Membership is then defined by
-- membership in that frozen set, never by timestamps, so it cannot change.
--
-- Manual cuts with an explicitly supplied past timestamp keep their original
-- created_at <= as_of semantics (cut_mode = 'timestamp').
--
-- The migration is idempotent: fresh databases apply 0001 then this upgrade;
-- existing databases apply only this upgrade.

-- 1. Commit-serial batches ---------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS activity_import_batches_id_seq;

CREATE TABLE IF NOT EXISTS activity_import_batches (
    id          bigint PRIMARY KEY DEFAULT nextval('activity_import_batches_id_seq'),
    committed_at timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE activity_import_batches_id_seq OWNED BY activity_import_batches.id;

-- 2. Tie every activity record to the import transaction that inserted it ----

ALTER TABLE activity_records
    ADD COLUMN IF NOT EXISTS import_batch_id bigint
    REFERENCES activity_import_batches(id);

-- Existing rows: attribute them to one immutable baseline batch (id 1) so that
-- pre-existing "now" cuts and closes keep including all data present at
-- upgrade time. Batch 1's row is created before any sequence value is read.
INSERT INTO activity_import_batches(id) VALUES (1) ON CONFLICT (id) DO NOTHING;
UPDATE activity_records SET import_batch_id = 1 WHERE import_batch_id IS NULL;

-- New imports always supply a batch id; the column stays nullable only so the
-- historical backfill above could target the rows that pre-date this upgrade.
ALTER TABLE activity_records
    ALTER COLUMN import_batch_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS activity_records_batch
    ON activity_records (import_batch_id);

-- 3. Cuts: distinguish frozen commit-set cuts from legacy timestamp cuts ----

ALTER TABLE activity_cuts
    ADD COLUMN IF NOT EXISTS cut_mode text NOT NULL DEFAULT 'timestamp';

ALTER TABLE activity_cuts DROP CONSTRAINT IF EXISTS activity_cuts_as_of_key;
-- timestamp cuts retain the as_of uniqueness used for idempotent creation;
-- committed cuts have as_of = NULL.
CREATE UNIQUE INDEX IF NOT EXISTS activity_cuts_as_of_uniq
    ON activity_cuts (as_of)
    WHERE as_of IS NOT NULL;

ALTER TABLE activity_cuts ALTER COLUMN as_of DROP NOT NULL;

-- 4. The frozen batch membership of each committed cut -----------------------

CREATE TABLE IF NOT EXISTS cut_batches (
    cut_id    integer NOT NULL REFERENCES activity_cuts(id) ON DELETE CASCADE,
    batch_id  bigint NOT NULL REFERENCES activity_import_batches(id),
    PRIMARY KEY (cut_id, batch_id)
);

CREATE INDEX IF NOT EXISTS cut_batches_batch ON cut_batches (batch_id);

-- 5. Sequence starts after the backfilled baseline batch ---------------------

SELECT setval(
    'activity_import_batches_id_seq',
    GREATEST(1, COALESCE((SELECT max(id) FROM activity_import_batches), 1)),
    true
);
