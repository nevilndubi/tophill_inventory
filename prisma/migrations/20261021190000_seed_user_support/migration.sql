-- Task 1.7 placeholder users are deliberately disconnected from Supabase and
-- can never authenticate. Task 2.2 replaces or links them during provisioning.
ALTER TABLE "users"
    ALTER COLUMN "supabase_user_id" DROP NOT NULL,
    ADD COLUMN "is_seed_data" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users"
    ADD CONSTRAINT "users_seed_identity_consistency_check"
        CHECK (
            ("is_seed_data" AND "supabase_user_id" IS NULL)
            OR (NOT "is_seed_data" AND "supabase_user_id" IS NOT NULL)
        );
