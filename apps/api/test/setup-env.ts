process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgres://gecko:gecko@localhost:5432/gecko_test";
process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.RATE_LIMIT_ENABLED ??= "false";
process.env.JOBS_ENABLED ??= "false";
