-- Migration: 20260926_enable_rls_lead_notes.sql
-- Description: Enable RLS and add tenant isolation policy for lead_notes

ALTER TABLE "public"."lead_notes" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'lead_notes' AND policyname = 'lead_notes_tenant_policy'
  ) THEN
    CREATE POLICY "lead_notes_tenant_policy" ON "public"."lead_notes"
      FOR ALL
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.tenant_users tu
          WHERE tu.tenant_id = lead_notes.tenant_id::text
            AND tu.user_id = (SELECT auth.uid())
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.tenant_users tu
          WHERE tu.tenant_id = lead_notes.tenant_id::text
            AND tu.user_id = (SELECT auth.uid())
        )
      );
  END IF;
END $$;
