-- Run cancellation contract (spec §2.4, APP-05).
-- The cancel route sets status 'cancelling' for runs whose worker is
-- mid-flight; the original CHECK constraint rejected that value, making
-- cancellation of a running run a 500. Rebuild the constraint with the
-- reconciling state included. Additive/compatible: no historical rows
-- change meaning, rollback restores the previous constraint.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check check (status in
  ('queued','running','cancelling','completed','failed','cancelled','interrupted'));

-- Rollback note:
--   alter table runs drop constraint runs_status_check;
--   alter table runs add constraint runs_status_check check (status in
--     ('queued','running','completed','failed','cancelled','interrupted'));
-- Apply only when no row is in 'cancelling'.
