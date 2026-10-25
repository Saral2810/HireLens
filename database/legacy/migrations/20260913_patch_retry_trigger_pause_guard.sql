-- Add campaign-status guard to trg_fn_schedule_retry
-- Prevents zombie call_queue rows for paused campaigns after in-flight calls complete
CREATE OR REPLACE FUNCTION trg_fn_schedule_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cq RECORD;
    v_next_attempt TIMESTAMPTZ;
    v_attempt_cap INT := 3;
    v_campaign_status TEXT;
BEGIN
    IF NEW.qa_extracted = true AND (TG_OP = 'INSERT' OR OLD.qa_extracted IS NULL OR OLD.qa_extracted = false) THEN
        PERFORM fn_release_slot(NEW.call_id);

        IF NEW.queue_id IS NOT NULL THEN
            SELECT * INTO v_cq FROM call_queue WHERE queue_id = NEW.queue_id;
        ELSE
            SELECT * INTO v_cq FROM call_queue
            WHERE active_lead_id = NEW.active_lead_id AND status = 'dispatched'
            LIMIT 1;
        END IF;

        IF v_cq IS NULL THEN
            RETURN NEW;
        END IF;

        -- NEW: If the campaign is not active, do not enqueue a retry row.
        -- Slot is already released above; this just prevents zombie queue rows.
        SELECT status INTO v_campaign_status FROM campaigns WHERE id = v_cq.campaign_id;
        IF v_campaign_status IS DISTINCT FROM 'active' THEN
            RAISE NOTICE '[RetryGuard] Campaign % is %, skipping retry enqueue.', v_cq.campaign_id, v_campaign_status;
            RETURN NEW;
        END IF;

        IF NEW.retry_required = true OR (NEW.lead_classification IS NULL AND NEW.dnd = false) THEN
            IF v_cq.attempt_number >= v_attempt_cap THEN
                UPDATE active_leads SET disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            ELSE
                IF v_cq.attempt_number = 1 THEN
                    v_next_attempt := now() + interval '5 minutes';
                ELSIF v_cq.attempt_number = 2 THEN
                    v_next_attempt := now() + interval '2 hours';
                ELSE
                    v_next_attempt := now() + interval '3 hours';
                END IF;

                IF NEW.callback_at IS NOT NULL THEN
                    v_next_attempt := NEW.callback_at;
                END IF;

                v_next_attempt := fn_next_callable_slot(v_next_attempt);

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
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
