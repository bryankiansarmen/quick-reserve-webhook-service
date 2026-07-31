import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | null = null;

/**
 * Lazily initialize the Supabase client using the service-role key.
 * The service-role key bypasses RLS by design — this is the only place in
 * the system it is used.
 * Returns null when the required env vars are not configured.
 */
export function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return null;
  }
  if (!supabase) {
    supabase = createClient(url, serviceRoleKey);
  }
  return supabase;
}
