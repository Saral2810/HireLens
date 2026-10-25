CREATE UNIQUE INDEX IF NOT EXISTS call_queue_active_lead_uniq
ON call_queue (phone)
WHERE status IN ('queued', 'calling');
