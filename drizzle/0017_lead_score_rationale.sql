-- SAFE: additive column with a default; no destructive statements.
-- Explainable lead scoring: the rubric factors behind `leads.score` are stored
-- alongside it, so any score can be justified after the fact (and a later
-- re-score can be diffed against the previous rationale).
ALTER TABLE "leads" ADD COLUMN "score_rationale" jsonb DEFAULT '{}'::jsonb NOT NULL;