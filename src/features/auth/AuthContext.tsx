import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../../lib/supabaseClient";

export type Role = "pending" | "staff" | "tournament_manager" | "cassa" | "cucina" | null;

interface AuthState {
  session: Session | null;
  role: Role;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/*
  Un solo login "tecnico" (Supabase Auth), due permessi diversi decisi
  dal RUOLO salvato nella tabella profiles (vedi supabase/schema.sql):
  - staff: può pubblicare annunci
  - tournament_manager: potrà gestire solo il torneo (quando costruiamo
    quella parte), NON gli annunci

  Il ruolo si legge dopo il login, non è nel token — così per cambiare
  i permessi di qualcuno basta aggiornare una riga nel database, senza
  toccare codice né far rifare login a nessuno con un token diverso.
*/
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setRole(null);
      return;
    }
    supabase
      .from("profiles")
      .select("role")
      .eq("id", session.user.id)
      .single()
      .then(({ data }) => setRole((data?.role as Role) ?? null));
  }, [session]);

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider value={{ session, role, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth va usato dentro <AuthProvider>");
  return ctx;
}
