-- Task 5.3: durable booking-create idempotency and the active-booking limit setting.
ALTER TABLE "bookings"
    ADD COLUMN "idempotency_key" VARCHAR(128);

ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_idempotency_key_format_check"
    CHECK (
        "idempotency_key" IS NULL
        OR (
            octet_length("idempotency_key") BETWEEN 8 AND 128
            AND "idempotency_key" ~ '^[ -~]+$'
        )
    );

CREATE UNIQUE INDEX "bookings_requested_by_user_id_idempotency_key_key"
    ON "bookings" ("requested_by_user_id", "idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "app_settings"
        WHERE "key" = 'booking.max_active_per_user'
          AND NOT (
              CASE
                  WHEN jsonb_typeof("value") = 'number'
                   AND "value"::text ~ '^[0-9]+$'
                  THEN ("value"::text)::integer BETWEEN 1 AND 100
                  ELSE FALSE
              END
          )
    ) THEN
        RAISE EXCEPTION 'Existing booking.max_active_per_user setting is invalid';
    END IF;
END
$$;

INSERT INTO "app_settings" ("key", "value")
VALUES ('booking.max_active_per_user', '10'::jsonb)
ON CONFLICT ("key") DO NOTHING;
