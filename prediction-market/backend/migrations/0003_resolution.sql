-- How a market settles when it is settled by data (Backtrace): the view, the condition and the pinned
-- calculation, plus `settlement` (the evidence: value, instance fingerprint) once it has resolved.
-- NULL for markets resolved by hand.
alter table markets add column resolution jsonb;
