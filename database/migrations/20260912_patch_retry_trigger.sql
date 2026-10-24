CREATE OR REPLACE FUNCTION trg_fn_schedule_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cq RECORD;
    v_next_attempt TIMESTAMPTZ;
    v_attempt_cap INT := 3;
BEGIN
    -- Trigger when qa_extracted is true on INSERT or when transitioning to true on UPDATE
    IF NEW.qa_extracted = true AND (TG_OP = 'INSERT' OR OLD.qa_extracted IS NULL OR OLD.qa_extracted = false) THEN
        
        -- BUGFIX 1: ALWAYS release the slot immediately. Do not block this on finding the queue record!
        PERFORM fn_release_slot(NEW.call_id);

        -- BUGFIX 2: Find the original queue record. If queue_id is null (e.g. from webhook), 
        -- resolve it using active_lead_id where status is 'dispatched'.
        IF NEW.queue_id IS NOT NULL THEN
            SELECT * INTO v_cq FROM call_queue WHERE queue_id = NEW.queue_id;
        ELSE
            SELECT * INTO v_cq FROM call_queue 
            WHERE active_lead_id = NEW.active_lead_id AND status = 'dispatched'
            LIMIT 1;
        END IF;

        -- If absolutely no queue record exists, we still return NEW (the slot was already released above)
        IF v_cq IS NULL THEN 
            RETURN NEW; 
        END IF;

        -- Check if it should be retried based on extraction flags
        IF NEW.retry_required = true OR (NEW.lead_classification IS NULL AND NEW.dnd = false) THEN
            
            IF v_cq.attempt_number >= v_attempt_cap THEN
                -- Disqualify due to max attempts
                UPDATE active_leads SET disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            ELSE
                -- Determine backoff time based on attempt number (simplified ladder)
                IF v_cq.attempt_number = 1 THEN
                    v_next_attempt := now() + interval '5 minutes';
                ELSIF v_cq.attempt_number = 2 THEN
                    v_next_attempt := now() + interval '2 hours';
                ELSE
                    v_next_attempt := now() + interval '3 hours';
                END IF;

                -- Override with callback_at if provided
                IF NEW.callback_at IS NOT NULL THEN
                    v_next_attempt := NEW.callback_at;
                END IF;

                -- Ensure retry attempt strictly respects legal calling hours (09:00-21:00 IST, Mon-Sat)
                v_next_attempt := fn_next_callable_slot(v_next_attempt);

                -- Insert new queued row for the next attempt
                -- Use ON CONFLICT DO UPDATE to satisfy the unique index if there's a race
                BEGIN
                    INSERT INTO call_queue (
                        tenant_id, active_lead_id, campaign_id, phone, attempt_number, next_attempt_at
                    ) VALUES (
                        NEW.tenant_id, NEW.active_lead_id, v_cq.campaign_id, NEW.phone, v_cq.attempt_number + 1, v_next_attempt
                    )
                    ON CONFLICT (active_lead_id) WHERE status IN ('queued', 'dispatched')
                    DO UPDATE SET 
                        attempt_number = EXCLUDED.attempt_number,
                        next_attempt_at = EXCLUDED.next_attempt_at;
                EXCEPTION WHEN unique_violation THEN
                    RAISE NOTICE '[RetryGuard] Phone % is already active in another campaign. Swallowing retry.', NEW.phone;
                END;
            END IF;
        ELSE
            -- Terminal state
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
