-- De inlognaam is altijd het e-mailadres (B74): losse gebruikersnamen vervallen bij wie een e-mailadres heeft.
-- Accounts zonder e-mailadres houden hun gebruikersnaam tot er een e-mailadres is ingevuld.
UPDATE "users" SET "username" = NULL WHERE "email" IS NOT NULL AND "username" IS NOT NULL;
