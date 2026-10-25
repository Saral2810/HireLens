-- Add launch_strategy to campaigns table to support tracking immediate vs scheduled vs draft auto-launches
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS launch_strategy VARCHAR(50) DEFAULT NULL;
