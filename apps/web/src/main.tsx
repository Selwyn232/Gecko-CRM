import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { toast } from "./components/Toast";
import { UpdateBar } from "./components/UpdateBar";
import "./styles.css";
import { startResponsiveTables } from "./responsiveTables";

/**
 * Na elke geslaagde actie een korte bevestiging ("Opgeslagen"). Eigen tekst of uitzetten via meta.toast.
 * Meldt de server dat een e-mail niet is verstuurd (emailStatus), dan geen "verstuurd"-melding: het scherm
 * toont zelf wat er misging.
 */
const mutationCache = new MutationCache({
  onSuccess: (data, _vars, _ctx, mutation) => {
    const setting = mutation.meta?.toast;
    if (setting === false) return;
    const status = data && typeof data === "object" && "emailStatus" in data ? (data as { emailStatus: unknown }).emailStatus : null;
    if (status && status !== "sent" && status !== "queued") return;
    toast(setting ?? "Opgeslagen");
  },
});
const queryClient = new QueryClient({ mutationCache, defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <UpdateBar />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

startResponsiveTables();
