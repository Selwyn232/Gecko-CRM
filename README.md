# Gecko CRM

Het centrale systeem van Gecko BV: klanten, projecten, productcatalogus, facturatie, planning,
klantcommunicatie en portalen voor partners en klanten.

- **Wat en waarom:** [`docs/`](docs/README.md) — requirements, domeinmodel, besluiten
- **Hoe we bouwen:** [`docs/10-ontwikkelen.md`](docs/10-ontwikkelen.md) — werkwijze en conventies

## Snel starten

Vereist: Node 22, pnpm 10, PostgreSQL 16 (of Docker).

```bash
pnpm install
docker compose up -d                      # lokale database (of eigen PostgreSQL)
cp apps/api/.env.example apps/api/.env    # vul ENCRYPTION_KEY in (zie bestand)
pnpm --filter @gecko/api db:migrate
pnpm --filter @gecko/api db:seed
ADMIN_PASSWORD='kies-een-lang-wachtwoord' pnpm --filter @gecko/api create-admin jij@gecko.nl "Jouw Naam"
pnpm dev                                  # API op http://localhost:3000
```

## Controles

```bash
pnpm typecheck
pnpm test          # gebruikt database gecko_test
```

CI draait dezelfde controles bij elke push, en faalt als het databaseschema is gewijzigd zonder migratie.

## Structuur

```
apps/api/                 Backend (TypeScript, Fastify, Drizzle, PostgreSQL)
  src/modules/<module>/   Elk domein apart: schema.ts, service.ts, routes.ts
  drizzle/                Databasemigraties (gegenereerd, gecommit, nooit achteraf wijzigen)
  test/                   Tests tegen een echte database
docs/                     Requirements, ontwerp en besluiten
```
