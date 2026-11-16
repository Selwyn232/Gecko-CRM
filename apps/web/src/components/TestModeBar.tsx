import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

/** Duidelijke waarschuwing zolang de testmodus aan staat. */
export function TestModeBar() {
  const status = useQuery({ queryKey: ["test-status"], queryFn: () => api.get<{ testMode: boolean }>("/testing/status"), staleTime: 60_000 });
  if (!status.data?.testMode) return null;
  return <div className="testmode-bar">TESTMODUS — vandaag plannen en rapporten direct indienen is toegestaan. Zet uit bij Instellingen voordat echte klanten worden verwerkt.</div>;
}
