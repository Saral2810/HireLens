# Database setup (Supabase)

## Easiest way — one file

1. Create a **new** Supabase project.
2. Open **SQL Editor**, paste the whole of `setup.sql`, and click **Run**.
3. Make yourself super admin (replace the email):

```sql
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"is_super_admin": true}'
WHERE email = 'you@example.com';
```

4. Put your project URL and service-role key in `.env` (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and add the same email to `SUPER_ADMIN_EMAILS`.

`setup.sql` is meant to be run **once** on an empty project. It was tested end-to-end on a fresh PostgreSQL 16 database (with a small stand-in for Supabase's `auth` schema): all tables and dialer functions are created with no errors.

## What is inside

| Folder / file | What it is |
|---|---|
| `schema.sql` | Base tables (leads, campaigns, call_sessions, call_queue, tenants, …) |
| `migrations/` | Changes added over time — run in filename order, skip `*_down.sql` |
| `rbac/` | Roles + row-level security (who can see which tenant's data) |
| `setup.sql` | All of the above joined in the right order |

`*_down.sql` files and the commented `-- DOWN` blocks are only for undoing a change. Don't run them during setup.

## Adding another voice provider later

`tenant_voice_providers.provider_type` only allows `'gnani'` and `'mock'`. To add a new one:

```sql
ALTER TABLE tenant_voice_providers DROP CONSTRAINT IF EXISTS tenant_voice_providers_provider_type_check;
ALTER TABLE tenant_voice_providers ADD CONSTRAINT tenant_voice_providers_provider_type_check
  CHECK (provider_type IN ('gnani', 'mock', 'your_new_provider'));
```
