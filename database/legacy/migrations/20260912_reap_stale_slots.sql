CREATE OR REPLACE FUNCTION reap_stale_slots(p_older_than_secs INT DEFAULT 240)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    n INT;
BEGIN
    UPDATE concurrency_slots
    SET released = true, released_at = now()
    WHERE released = false 
      AND reserved_at < now() - (p_older_than_secs || ' seconds')::interval;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      UPDATE concurrency_settings SET global_active = GREATEST(global_active - n, 0) WHERE id = 1;
      RAISE NOTICE '[reap_stale_slots] Released % stale slots', n;
    END IF;
    RETURN n;
END;
$$;
