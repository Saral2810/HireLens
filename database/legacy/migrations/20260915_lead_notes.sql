-- Migration: 20260915_lead_notes.sql
-- Create lead_notes table for internal agent notes and commentary on leads

CREATE TABLE IF NOT EXISTS public.lead_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    agent_id VARCHAR(100) DEFAULT 'system',
    note_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- High-throughput index for loading notes by lead and tenant ordered by creation time
CREATE INDEX IF NOT EXISTS idx_lead_notes_lookup ON public.lead_notes(tenant_id, lead_id, created_at DESC);

-- Disable RLS or set permissive for backend service role operations matching existing architecture
ALTER TABLE public.lead_notes DISABLE ROW LEVEL SECURITY;
