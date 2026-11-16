-- Nieuwe rechten voor klanten, projecten en klantreizen toekennen aan bestaande standaardrollen.
-- Rollen die een beheerder al heeft aangepast, krijgen alleen rechten erbij, er gaat niets af.
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('klantspecialist', 'customers.read'), ('klantspecialist', 'customers.manage'),
  ('klantspecialist', 'projects.read'), ('klantspecialist', 'projects.manage'),
  ('planner', 'customers.read'), ('planner', 'projects.read'), ('planner', 'projects.manage'),
  ('finance', 'customers.read'), ('finance', 'projects.read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
