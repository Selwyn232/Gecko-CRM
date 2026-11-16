import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api";

interface AuthValue {
  me: Me | null;
  can: (permission: string) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.get<Me>("/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
  });

  if (meQuery.isLoading) return <div className="auth-wrap muted">Laden…</div>;

  const me = meQuery.data ?? null;
  const value: AuthValue = {
    me,
    can: (p) => !!me?.permissions.includes(p),
    refresh: async () => {
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
    logout: async () => {
      await api.post("/auth/logout").catch(() => undefined);
      qc.clear();
      await qc.invalidateQueries({ queryKey: ["me"] });
    },
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth buiten AuthProvider");
  return ctx;
}
