-- CreateEnum
CREATE TYPE "attachment_entity_type" AS ENUM ('MACHINE', 'TICKET');

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" INET,
    "request_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "emailed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "in_app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id", "type")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_type" "attachment_entity_type" NOT NULL,
    "entity_id" UUID NOT NULL,
    "storage_path" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- Open-ended event identifiers remain text, with a stable wire-format contract.
ALTER TABLE "audit_logs"
    ADD CONSTRAINT "audit_logs_action_format_check"
        CHECK ("action" ~ '^[a-z0-9._]{1,64}$'),
    ADD CONSTRAINT "audit_logs_entity_type_format_check"
        CHECK ("entity_type" ~ '^[a-z0-9._]{1,64}$'),
    ADD CONSTRAINT "audit_logs_entity_id_length_check"
        CHECK (char_length("entity_id") BETWEEN 1 AND 256 AND btrim("entity_id") <> ''),
    ADD CONSTRAINT "audit_logs_request_id_length_check"
        CHECK (char_length("request_id") BETWEEN 1 AND 128 AND btrim("request_id") <> ''),
    ADD CONSTRAINT "audit_logs_before_object_check"
        CHECK ("before" IS NULL OR jsonb_typeof("before") IN ('object', 'null')),
    ADD CONSTRAINT "audit_logs_after_object_check"
        CHECK ("after" IS NULL OR jsonb_typeof("after") IN ('object', 'null')),
    ADD CONSTRAINT "audit_logs_payload_size_check"
        CHECK (
            COALESCE(pg_column_size("before"), 0)
            + COALESCE(pg_column_size("after"), 0)
            <= 65536
        );

ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_type_format_check"
        CHECK ("type" ~ '^[a-z0-9._]{1,64}$'),
    ADD CONSTRAINT "notifications_title_length_check"
        CHECK (char_length("title") BETWEEN 1 AND 200 AND btrim("title") <> ''),
    ADD CONSTRAINT "notifications_body_length_check"
        CHECK (char_length("body") BETWEEN 1 AND 4000 AND btrim("body") <> ''),
    ADD CONSTRAINT "notifications_entity_reference_pair_check"
        CHECK (("entity_type" IS NULL) = ("entity_id" IS NULL)),
    ADD CONSTRAINT "notifications_entity_type_format_check"
        CHECK ("entity_type" IS NULL OR "entity_type" ~ '^[a-z0-9._]{1,64}$'),
    ADD CONSTRAINT "notifications_entity_id_length_check"
        CHECK (
            "entity_id" IS NULL
            OR (char_length("entity_id") BETWEEN 1 AND 256 AND btrim("entity_id") <> '')
        ),
    ADD CONSTRAINT "notifications_read_at_order_check"
        CHECK ("read_at" IS NULL OR "read_at" >= "created_at"),
    ADD CONSTRAINT "notifications_emailed_at_order_check"
        CHECK ("emailed_at" IS NULL OR "emailed_at" >= "created_at");

ALTER TABLE "notification_preferences"
    ADD CONSTRAINT "notification_preferences_type_format_check"
        CHECK ("type" ~ '^[a-z0-9._]{1,64}$');

ALTER TABLE "attachments"
    ADD CONSTRAINT "attachments_storage_path_length_check"
        CHECK (char_length("storage_path") BETWEEN 1 AND 1024 AND btrim("storage_path") <> ''),
    ADD CONSTRAINT "attachments_file_name_length_check"
        CHECK (char_length("file_name") BETWEEN 1 AND 255 AND btrim("file_name") <> ''),
    ADD CONSTRAINT "attachments_mime_type_allowed_check"
        CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
    ADD CONSTRAINT "attachments_size_bytes_check"
        CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760);

ALTER TABLE "app_settings"
    ADD CONSTRAINT "app_settings_key_format_check"
        CHECK ("key" ~ '^[a-z0-9._]{1,128}$');

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_created_at_idx"
ON "audit_logs"("entity_type", "entity_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx"
ON "audit_logs"("actor_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx"
ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx"
ON "notifications"("user_id", "read_at");

-- Supports the unread bell count and newest-first unread notification feed.
CREATE INDEX "notifications_unread_user_id_created_at_idx"
ON "notifications"("user_id", "created_at" DESC)
WHERE "read_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_path_key" ON "attachments"("storage_path");

-- CreateIndex
CREATE INDEX "attachments_entity_type_entity_id_idx"
ON "attachments"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Audit rows are immutable to ordinary writes even before Task 10.1 introduces an app role.
CREATE OR REPLACE FUNCTION "prevent_audit_log_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs are append-only'
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER "audit_logs_append_only"
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW
EXECUTE FUNCTION "prevent_audit_log_mutation"();

-- These are plain JSON numbers. Task 5.1 owns semantic validation in the API.
INSERT INTO "app_settings" ("key", "value")
VALUES
    ('booking.max_duration_minutes', '240'::jsonb),
    ('booking.min_lead_minutes', '15'::jsonb),
    ('booking.no_show_grace_minutes', '15'::jsonb),
    ('checkout.adhoc_guard_minutes', '30'::jsonb)
ON CONFLICT ("key") DO NOTHING;
