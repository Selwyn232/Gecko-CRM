-- Fictief e-mailadres in de voettekst van alle e-mails vervangen door een bestaand adres
-- (een niet-bestaand domein zoals gecko.example is een spamsignaal).
UPDATE organizations SET email = 'selwyn@gecko.nl' WHERE type = 'gecko' AND email = 'info@gecko.example';
