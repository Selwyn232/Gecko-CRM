-- Rol "medewerker": alles gebruiken, niets instellen.
-- Geen beheer van gebruikers, rollen, organisaties, producten, prijzen, klantreizen of systeeminstellingen.
INSERT INTO roles (key, name, description, is_system)
VALUES ('medewerker', 'Medewerker', 'Kan het hele CRM gebruiken, maar geen instellingen wijzigen', false)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
CROSS JOIN (VALUES
  ('customers.read'), ('customers.manage'), ('projects.read'), ('projects.manage'),
  ('catalog.read'), ('purchase_prices.read'), ('organizations.read'), ('users.read'), ('audit.read')
) AS p(permission)
WHERE r.key = 'medewerker'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Renee, Barry en Jurriaan: van beheerder naar medewerker (Selwyn blijft beheerder). Bestaan ze niet, dan gebeurt er niets.
INSERT INTO audit_log (action, entity_type, entity_id, changes, metadata)
SELECT 'user.updated', 'user', u.id::text,
       '{"roles": {"from": "Beheerder", "to": "Medewerker"}}'::jsonb,
       '{"source": "migratie 0005_role_medewerker"}'::jsonb
FROM users u
WHERE lower(u.username) IN ('renee', 'barry', 'jurriaan')
  AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'beheerder');
--> statement-breakpoint
DELETE FROM user_roles ur
USING users u, roles r
WHERE ur.user_id = u.id AND ur.role_id = r.id
  AND r.key = 'beheerder' AND lower(u.username) IN ('renee', 'barry', 'jurriaan');
--> statement-breakpoint
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE r.key = 'medewerker' AND lower(u.username) IN ('renee', 'barry', 'jurriaan')
ON CONFLICT DO NOTHING;
