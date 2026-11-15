-- Report form quotas (see src/worker/report_quota.ts): one row per client
-- (a SHA-256 of its address or IPv6 /64, never the address itself) plus one
-- row for the site-wide daily cap. Rows of closed windows are deleted by the
-- daily cron.
CREATE TABLE report_quota (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
