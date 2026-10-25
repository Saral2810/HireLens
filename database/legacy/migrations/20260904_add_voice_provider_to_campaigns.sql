-- Add voice_provider column to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_provider text;

-- Backfill existing rows to the default provider
UPDATE campaigns SET voice_provider = 'gnani' WHERE voice_provider IS NULL;
