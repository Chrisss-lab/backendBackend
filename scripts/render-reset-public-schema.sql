-- Run once on Render Postgres after a failed Prisma migration (P3009).
-- Use External DATABASE_URL (sslmode=require). CURRENT_USER is the DB role in the URL.
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
GRANT ALL ON SCHEMA public TO public;
