import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Vero finché Andrea non ha ancora incollato le chiavi in .env.local —
// a quel punto tutto ciò che dipende da Supabase mostra uno stato
// "non configurato" onesto invece di rompersi in silenzio.
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(supabaseUrl ?? "https://placeholder.supabase.co", supabaseAnonKey ?? "placeholder");
