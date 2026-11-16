-- Standaard automatische statuswissels bij planningsgebeurtenissen (zelf aan te passen in Klantreizen).
UPDATE journey_statuses SET auto_on_events = ARRAY['survey.scheduled'] WHERE key = 'schouw_ingepland' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['survey.report_submitted'] WHERE key = 'schouw_uitgevoerd' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['extra_work.proposed'] WHERE key = 'meerwerk_akkoord' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['survey.report_approved', 'extra_work.accepted'] WHERE key = 'installatie_inplannen' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['installation.scheduled'] WHERE key = 'installatie_ingepland' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['installation.report_submitted'] WHERE key = 'oplevering_controle' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['installation.report_approved'] WHERE key = 'eindfactuur_open' AND auto_on_events = '{}';
--> statement-breakpoint
-- Rechten voor planning aan bestaande rollen.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission FROM roles r
JOIN (VALUES
  ('medewerker', 'planning.read'), ('medewerker', 'planning.manage'),
  ('planner', 'planning.read'), ('planner', 'planning.manage'),
  ('klantspecialist', 'planning.read'), ('finance', 'planning.read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Rol voor medewerkers van installatiepartners: alleen het partnerportaal.
INSERT INTO roles (key, name, description, is_system)
VALUES ('installatiepartner', 'Installatiepartner', 'Toegang tot het partnerportaal: eigen afspraken, beschikbaarheid en rapporten', true)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT id, 'partner.portal' FROM roles WHERE key = 'installatiepartner'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['deposit.paid'] WHERE key = 'aanbetaling_ontvangen' AND auto_on_events = '{}';
--> statement-breakpoint
UPDATE journey_statuses SET auto_on_events = ARRAY['final.paid'] WHERE key = 'afgerond' AND auto_on_events = '{}';
