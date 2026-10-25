-- 01_dialer_internals.sql
-- Dialer Internals - Migration to Postgres-driven state machine

-- 1. TABLES
-- The Five-Table Spine

-- active_leads: The working set. The canonical phone number lives here.
CREATE TABLE IF NOT EXISTS active_leads (
    active_lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    total_attempts INT NOT NULL DEFAULT 0,
    total_connects INT NOT NULL DEFAULT 0,
    dnd BOOLEAN NOT NULL DEFAULT false,
    lead_classification VARCHAR(50),
    disqualified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- call_queue: The dialer's work list.
CREATE TABLE IF NOT EXISTS call_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'queued', -- queued, dispatched, completed, failed
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provisional_call_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index to enforce one pending attempt per lead, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cq_active ON call_queue(active_lead_id) 
WHERE status IN ('queued', 'dispatched');

-- call_logs: Immutable attempt history. Target of LLM extraction.
CREATE TABLE IF NOT EXISTS call_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    queue_id UUID REFERENCES call_queue(queue_id) ON DELETE SET NULL,
    call_id VARCHAR(255) UNIQUE NOT NULL, -- Telephony provider's call ID
    phone VARCHAR(50) NOT NULL, -- The dialed string
    status VARCHAR(50) NOT NULL,
    duration_seconds INT NOT NULL DEFAULT 0,
    recording_url TEXT,
    recording_min_role VARCHAR(50) DEFAULT 'admin',
    transcript JSONB,
    qa_extracted BOOLEAN NOT NULL DEFAULT false,
    -- Extracted fields
    lead_classification VARCHAR(50),
    retry_required BOOLEAN NOT NULL DEFAULT false,
    dnd BOOLEAN NOT NULL DEFAULT false,
    purchase_timeline BOOLEAN NOT NULL DEFAULT false,
    callback_at TIMESTAMPTZ,
    motivation TEXT,
    struggle_area TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- archived_leads: Terminal outcomes to keep active_leads small.
CREATE TABLE IF NOT EXISTS archived_leads (
    archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    archive_reason VARCHAR(100) NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    original_data JSONB NOT NULL
);

-- Concurrency Settings & Slots
CREATE TABLE IF NOT EXISTS concurrency_settings (
    id INT PRIMARY KEY DEFAULT 1, -- Single row
    global_max INT NOT NULL DEFAULT 10,
    global_active INT NOT NULL DEFAULT 0,
    slot_timeout_secs INT NOT NULL DEFAULT 240,
    dispatch_active BOOLEAN NOT NULL DEFAULT false,
    dispatch_run_id VARCHAR(255),
    dispatch_lease_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS concurrency_slots (
    slot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    call_id VARCHAR(255) UNIQUE NOT NULL,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    released BOOLEAN NOT NULL DEFAULT false,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
);

-- 2. PL/pgSQL FUNCTIONS

-- fn_dispatch_acquire: Claim the run. Test-and-set in one statement.
CREATE OR REPLACE FUNCTION fn_dispatch_acquire(p_run_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_acquired BOOLEAN;
BEGIN
    UPDATE concurrency_settings
    SET dispatch_active = true,
        dispatch_run_id = p_run_id,
        dispatch_lease_until = now() + interval '1 minute'
    WHERE id = 1 
      AND (dispatch_active = false OR dispatch_lease_until < now())
    RETURNING true INTO v_acquired;
    
    RETURN COALESCE(v_acquired, false);
END;
$$;

-- fn_dispatch_release: Release the lease.
CREATE OR REPLACE FUNCTION fn_dispatch_release(p_run_id VARCHAR)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE concurrency_settings
    SET dispatch_active = false,
        dispatch_run_id = NULL
    WHERE id = 1 AND dispatch_run_id = p_run_id;
END;
$$;

-- fn_reserve_slot: Atomically check limits and reserve a slot.
CREATE OR REPLACE FUNCTION fn_reserve_slot(
    p_tenant_id VARCHAR, 
    p_campaign_id UUID, 
    p_call_id VARCHAR, 
    p_run_id VARCHAR
)
RETURNS TABLE (
    allowed BOOLEAN,
    reason VARCHAR,
    out_global_active INT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings RECORD;
    v_campaign_active INT;
    v_campaign_max INT;
BEGIN
    -- Check if lead is already dialing (prevent duplicates)
    IF EXISTS (SELECT 1 FROM concurrency_slots WHERE call_id = p_call_id AND released = false) THEN
        RETURN QUERY SELECT false, 'lead_already_dialing'::VARCHAR, 0;
        RETURN;
    END IF;

    -- Lock the settings row to check global capacity
    SELECT * INTO v_settings FROM concurrency_settings WHERE id = 1 FOR UPDATE;
    
    IF v_settings.global_active >= v_settings.global_max THEN
        RETURN QUERY SELECT false, 'global_limit_reached'::VARCHAR, v_settings.global_active;
        RETURN;
    END IF;

    -- Get campaign specific max concurrency
    SELECT max_concurrency INTO v_campaign_max FROM campaigns WHERE id = p_campaign_id;
    
    -- Get current active slots for this campaign
    SELECT COUNT(*) INTO v_campaign_active 
    FROM concurrency_slots 
    WHERE campaign_id = p_campaign_id AND released = false;

    IF v_campaign_active >= v_campaign_max THEN
        RETURN QUERY SELECT false, 'agent_limit_reached'::VARCHAR, v_settings.global_active;
        RETURN;
    END IF;

    -- All checks passed, reserve slot
    INSERT INTO concurrency_slots (tenant_id, campaign_id, call_id)
    VALUES (p_tenant_id, p_campaign_id, p_call_id);

    UPDATE concurrency_settings
    SET global_active = global_active + 1,
        dispatch_lease_until = now() + interval '1 minute'
    WHERE id = 1
    RETURNING global_active INTO out_global_active;

    RETURN QUERY SELECT true, 'allowed'::VARCHAR, out_global_active;
END;
$$;

-- fn_release_slot: Release an active slot
CREATE OR REPLACE FUNCTION fn_release_slot(p_call_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_released BOOLEAN;
BEGIN
    UPDATE concurrency_slots
    SET released = true,
        released_at = now()
    WHERE call_id = p_call_id AND released = false
    RETURNING true INTO v_released;

    IF v_released THEN
        UPDATE concurrency_settings
        SET global_active = GREATEST(global_active - 1, 0)
        WHERE id = 1;
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

-- fn_reap_stranded_dispatches: Recover slots from calls that never got a webhook.
CREATE OR REPLACE FUNCTION fn_reap_stranded_dispatches()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_timeout INT;
    v_stranded_record RECORD;
BEGIN
    SELECT slot_timeout_secs INTO v_timeout FROM concurrency_settings WHERE id = 1;
    
    FOR v_stranded_record IN 
        SELECT cs.call_id 
        FROM concurrency_slots cs
        WHERE cs.released = false 
          AND cs.reserved_at < (now() - (v_timeout || ' seconds')::interval)
    LOOP
        -- Release slot
        PERFORM fn_release_slot(v_stranded_record.call_id);
        
        -- Mark as failed in call_queue
        UPDATE call_queue 
        SET status = 'failed' 
        WHERE provisional_call_id = v_stranded_record.call_id;
    END LOOP;
END;
$$;

-- Helper function: Returns earliest legal calling slot (09:00-21:00 IST, Mon-Sat)
CREATE OR REPLACE FUNCTION fn_next_callable_slot(p_target TIMESTAMPTZ DEFAULT now())
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_ist TIMESTAMP := (p_target AT TIME ZONE 'Asia/Kolkata');
    v_hour INT := EXTRACT(HOUR FROM v_ist);
    v_dow INT := EXTRACT(DOW FROM v_ist); -- 0 = Sunday
    v_candidate_date DATE := v_ist::date;
BEGIN
    -- If within 9am - 9pm and not Sunday
    IF v_dow != 0 AND v_hour >= 9 AND v_hour < 21 THEN
        RETURN p_target;
    END IF;

    -- If past 9pm, advance to next day
    IF v_hour >= 21 THEN
        v_candidate_date := (v_candidate_date + 1);
    END IF;

    -- Skip Sunday
    WHILE EXTRACT(DOW FROM v_candidate_date) = 0 LOOP
        v_candidate_date := (v_candidate_date + 1);
    END LOOP;

    -- Return 09:00:00 IST converted to timestamptz
    RETURN (v_candidate_date::text || ' 09:00:00+05:30')::timestamptz;
END;
$$;

-- 3. TRIGGERS
-- Trigger to schedule retry when qa_extracted is flipped to true
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
                INSERT INTO call_queue (
                    tenant_id, active_lead_id, campaign_id, phone, attempt_number, next_attempt_at
                ) VALUES (
                    NEW.tenant_id, NEW.active_lead_id, v_cq.campaign_id, NEW.phone, v_cq.attempt_number + 1, v_next_attempt
                )
                ON CONFLICT (active_lead_id) WHERE status IN ('queued', 'dispatched')
                DO UPDATE SET 
                    attempt_number = EXCLUDED.attempt_number,
                    next_attempt_at = EXCLUDED.next_attempt_at;
            END IF;
        ELSE
            -- Terminal state
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;

        -- Mark the original queue item as completed
        UPDATE call_queue SET status = 'completed' WHERE queue_id = v_cq.queue_id;
        
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c_schedule_retry ON call_logs;
CREATE TRIGGER trg_c_schedule_retry
AFTER INSERT OR UPDATE ON call_logs
FOR EACH ROW
EXECUTE FUNCTION trg_fn_schedule_retry();

-- Trigger to guarantee instant slot release when a call session ends
CREATE OR REPLACE FUNCTION trg_fn_release_slot_on_call_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ended_at IS NOT NULL OR NEW.disposition NOT IN ('calling', 'in-progress', 'in_progress', 'queued') THEN
        IF NEW.provider_session_id IS NOT NULL THEN
            -- Release the slot immediately
            PERFORM fn_release_slot(NEW.provider_session_id);
            
            -- Also sync call_queue status if it was in dispatched state
            UPDATE call_queue
            SET status = CASE 
                WHEN NEW.disposition IN ('completed', 'interested', 'enrolled', 'won') THEN 'completed'
                ELSE 'failed'
            END,
            updated_at = now()
            WHERE provisional_call_id = NEW.provider_session_id 
              AND status = 'dispatched';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c_release_slot_on_call_session ON call_sessions;
CREATE TRIGGER trg_c_release_slot_on_call_session
AFTER INSERT OR UPDATE ON call_sessions
FOR EACH ROW
EXECUTE FUNCTION trg_fn_release_slot_on_call_session();

-- Insert initial concurrency settings row if it doesn't exist
INSERT INTO concurrency_settings (id, global_max) VALUES (1, 10) ON CONFLICT (id) DO NOTHING;

