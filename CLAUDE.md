# Instructies voor Claude

- Lees `docs/README.md` voor de context en `docs/10-ontwikkelen.md` voor de conventies; volg die strikt.
- Bedrijfsbesluiten staan in `docs/09-besluiten-en-open-punten.md`. Wijkt een verzoek af van een besluit, benoem dat.
- Schemawijziging → `pnpm --filter @gecko/api db:generate` en het nieuwe migratiebestand meecommitten.
- Na elke wijziging: `pnpm typecheck` en `pnpm test` (PostgreSQL moet draaien; database `gecko_test`).
- Communicatie met de gebruiker in het Nederlands.
