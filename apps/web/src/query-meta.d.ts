import "@tanstack/react-query";

declare module "@tanstack/react-query" {
  interface Register {
    /** toast: eigen bevestigingstekst na een geslaagde actie, of false voor geen melding (zie components/Toast.tsx). */
    mutationMeta: { toast?: string | false };
  }
}
