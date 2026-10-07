-- Make a cut's as_of predicate identify a stable record set under concurrent
-- imports.
--
-- The original default was now() (= transaction_timestamp()), i.e. the
-- transaction START time. An import transaction that stayed open across a cut
-- therefore stamped its rows with a created_at older than the cut's as_of:
-- the rows were invisible to the first query (not yet committed) but became
-- visible to every later query against the very same cut after COMMIT — the
-- "the same cut returns a different total later" defect.
--
-- clock_timestamp() is the wall-clock time of statement execution. Every
-- writer captures it immediately after taking the ACTIVITY_VISIBILITY_LOCK_KEY
-- advisory lock in SHARED mode (one timestamp reused by the whole batch); a
-- "now" cut / a monthly close takes that lock EXCLUSIVE, draining every
-- in-flight writer before stamping as_of. Hence every row with
-- created_at <= as_of is guaranteed committed before the cut exists, and a
-- cut is always queried later into the identical set.
ALTER TABLE activity_records
    ALTER COLUMN created_at SET DEFAULT clock_timestamp();

COMMENT ON COLUMN activity_records.created_at IS
    'Batch wall-clock stamp (clock_timestamp captured while holding the '
    'activity visibility shared advisory lock), NOT transaction start. '
    'Together with the exclusive lock taken by a "now" cut / monthly close '
    'this makes created_at <= cut.as_of a stable, commit-ordered visibility '
    'predicate. Application INSERTs pass this explicitly in microsecond text; '
    'this default only covers inserts that omit the column.';
