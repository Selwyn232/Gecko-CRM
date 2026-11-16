-- Rechten voor offertes en adviseurs toekennen aan bestaande standaardrollen (alleen toevoegen).
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('medewerker', 'quotes.read'), ('medewerker', 'quotes.manage'),
  ('klantspecialist', 'quotes.read'), ('klantspecialist', 'quotes.manage'),
  ('planner', 'quotes.read'),
  ('finance', 'quotes.read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
