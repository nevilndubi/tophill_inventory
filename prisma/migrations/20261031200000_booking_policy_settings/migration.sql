DO $$
DECLARE
    minimum_duration INTEGER;
    maximum_duration INTEGER;
BEGIN
    SELECT CASE
        WHEN jsonb_typeof("value") = 'number' AND "value"::text ~ '^-?[0-9]+$'
            THEN ("value"::text)::integer
        ELSE NULL
    END
    INTO minimum_duration
    FROM "app_settings"
    WHERE "key" = 'booking.min_duration_minutes';
    IF NOT FOUND THEN
        minimum_duration := 15;
    ELSIF minimum_duration IS NULL THEN
        RAISE EXCEPTION 'Cannot apply booking policy: booking.min_duration_minutes is not an integer JSON number';
    END IF;

    SELECT CASE
        WHEN jsonb_typeof("value") = 'number' AND "value"::text ~ '^-?[0-9]+$'
            THEN ("value"::text)::integer
        ELSE NULL
    END
    INTO maximum_duration
    FROM "app_settings"
    WHERE "key" = 'booking.max_duration_minutes';
    IF NOT FOUND THEN
        maximum_duration := 240;
    ELSIF maximum_duration IS NULL THEN
        RAISE EXCEPTION 'Cannot apply booking policy: booking.max_duration_minutes is not an integer JSON number';
    END IF;

    IF minimum_duration > maximum_duration THEN
        RAISE EXCEPTION 'Cannot apply booking policy: global minimum duration exceeds global maximum';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "machines"
        WHERE "max_booking_minutes" IS NOT NULL
          AND "max_booking_minutes" < minimum_duration
    ) OR EXISTS (
        SELECT 1
        FROM "machine_categories"
        WHERE "default_max_booking_minutes" IS NOT NULL
          AND "default_max_booking_minutes" < minimum_duration
    ) THEN
        RAISE EXCEPTION
            'Cannot apply booking policy: a machine or category maximum is below the global minimum duration';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "machines"
        WHERE "buffer_minutes" IS NOT NULL
          AND ("buffer_minutes" < 0 OR "buffer_minutes" > 240)
    ) THEN
        RAISE EXCEPTION
            'Cannot apply booking buffer range: existing machine buffer_minutes values fall outside 0-240';
    END IF;
END;
$$;

ALTER TABLE "machines"
    DROP CONSTRAINT IF EXISTS "machines_buffer_minutes_positive_check";

ALTER TABLE "machines"
    DROP CONSTRAINT IF EXISTS "machines_buffer_minutes_range_check";

ALTER TABLE "machines"
    ADD CONSTRAINT "machines_buffer_minutes_range_check"
        CHECK ("buffer_minutes" IS NULL OR ("buffer_minutes" >= 0 AND "buffer_minutes" <= 240));

INSERT INTO "app_settings" ("key", "value")
VALUES
    ('booking.max_duration_minutes', '240'::jsonb),
    ('booking.min_lead_minutes', '15'::jsonb),
    ('booking.no_show_grace_minutes', '15'::jsonb),
    ('checkout.adhoc_guard_minutes', '30'::jsonb),
    ('booking.max_advance_days', '60'::jsonb),
    ('booking.min_duration_minutes', '15'::jsonb),
    ('booking.default_buffer_minutes', '0'::jsonb)
ON CONFLICT ("key") DO NOTHING;
