# Backup-job voor Render (Cron Job, runtime Docker). Zie docs/12-backup.md.
# De hoofdversie van pg_dump moet gelijk aan of hoger dan die van de database zijn:
# bij een upgrade van Render Postgres deze basisimage mee ophogen.
FROM postgres:16-alpine
RUN apk add --no-cache age curl
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
