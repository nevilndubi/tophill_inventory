-- CreateEnum
CREATE TYPE "machine_condition" AS ENUM ('OPERATIONAL', 'NEEDS_SERVICE', 'UNDER_MAINTENANCE', 'OUT_OF_SERVICE', 'RETIRED');

-- CreateEnum
CREATE TYPE "machine_status_source" AS ENUM ('MANUAL', 'SERVICE_TICKET', 'SCHEDULE', 'SYSTEM');

-- Race-safe, database-owned human-readable asset tags.
CREATE SEQUENCE "machine_asset_tag_seq" AS BIGINT START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION "next_machine_asset_tag"() RETURNS TEXT AS $$
    SELECT 'HM-' || lpad(nextval('machine_asset_tag_seq')::TEXT, 6, '0');
$$ LANGUAGE SQL VOLATILE;

-- CreateTable
CREATE TABLE "machine_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_service_interval_days" INTEGER,
    "default_max_booking_minutes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asset_tag" TEXT NOT NULL DEFAULT next_machine_asset_tag(),
    "name" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "description" TEXT,
    "department_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "purchase_date" DATE,
    "warranty_expires_on" DATE,
    "commissioned_on" DATE,
    "retired_on" DATE,
    "condition" "machine_condition" NOT NULL DEFAULT 'OPERATIONAL',
    "is_bookable" BOOLEAN NOT NULL DEFAULT true,
    "requires_approval" BOOLEAN NOT NULL DEFAULT false,
    "allow_booking_when_needs_service" BOOLEAN NOT NULL DEFAULT false,
    "max_booking_minutes" INTEGER,
    "buffer_minutes" INTEGER,
    "service_interval_days" INTEGER,
    "last_serviced_at" TIMESTAMPTZ(3),
    "next_service_due_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "machine_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "from_condition" "machine_condition",
    "to_condition" "machine_condition" NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "source" "machine_status_source" NOT NULL,
    "ticket_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "machine_status_history_pkey" PRIMARY KEY ("id")
);

-- Positive nullable defaults and overrides.
ALTER TABLE "machine_categories"
    ADD CONSTRAINT "machine_categories_default_service_interval_days_positive_check"
        CHECK ("default_service_interval_days" IS NULL OR "default_service_interval_days" > 0),
    ADD CONSTRAINT "machine_categories_default_max_booking_minutes_positive_check"
        CHECK ("default_max_booking_minutes" IS NULL OR "default_max_booking_minutes" > 0);

ALTER TABLE "machines"
    ADD CONSTRAINT "machines_manufacturer_not_blank_check"
        CHECK (length("manufacturer") > 0),
    ADD CONSTRAINT "machines_serial_number_not_blank_check"
        CHECK (length("serial_number") > 0),
    ADD CONSTRAINT "machines_max_booking_minutes_positive_check"
        CHECK ("max_booking_minutes" IS NULL OR "max_booking_minutes" > 0),
    ADD CONSTRAINT "machines_buffer_minutes_positive_check"
        CHECK ("buffer_minutes" IS NULL OR "buffer_minutes" > 0),
    ADD CONSTRAINT "machines_service_interval_days_positive_check"
        CHECK ("service_interval_days" IS NULL OR "service_interval_days" > 0),
    ADD CONSTRAINT "machines_retirement_consistency_check"
        CHECK (
            ("condition" = 'RETIRED' AND "retired_on" IS NOT NULL)
            OR ("condition" <> 'RETIRED' AND "retired_on" IS NULL)
        ),
    ADD CONSTRAINT "machines_warranty_after_commission_check"
        CHECK (
            "warranty_expires_on" IS NULL
            OR "commissioned_on" IS NULL
            OR "warranty_expires_on" >= "commissioned_on"
        );

-- Normalize the manufacturer/serial identity for every write path.
CREATE FUNCTION "normalize_machine_identity"() RETURNS TRIGGER AS $$
BEGIN
    NEW."manufacturer" = lower(btrim(NEW."manufacturer"));
    NEW."serial_number" = lower(btrim(NEW."serial_number"));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "machines_normalize_identity"
BEFORE INSERT OR UPDATE OF "manufacturer", "serial_number" ON "machines"
FOR EACH ROW EXECUTE FUNCTION "normalize_machine_identity"();

-- CreateIndex
CREATE UNIQUE INDEX "machine_categories_name_key" ON "machine_categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "machines_asset_tag_key" ON "machines"("asset_tag");

-- Serial identities remain reserved across soft deletion.
CREATE UNIQUE INDEX "machines_manufacturer_serial_number_lower_key"
ON "machines"(lower("manufacturer"), lower("serial_number"));

-- CreateIndex
CREATE INDEX "machines_department_id_idx" ON "machines"("department_id");

-- CreateIndex
CREATE INDEX "machines_category_id_idx" ON "machines"("category_id");

-- CreateIndex
CREATE INDEX "machines_condition_idx" ON "machines"("condition");

-- CreateIndex
CREATE INDEX "machines_next_service_due_at_idx" ON "machines"("next_service_due_at");

-- CreateIndex
CREATE INDEX "machine_status_history_machine_id_created_at_idx" ON "machine_status_history"("machine_id", "created_at" DESC);

-- Substring search indexes used by the machine registry.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "machines_name_trgm_idx" ON "machines" USING GIN ("name" gin_trgm_ops);
CREATE INDEX "machines_asset_tag_trgm_idx" ON "machines" USING GIN ("asset_tag" gin_trgm_ops);
CREATE INDEX "machines_serial_number_trgm_idx" ON "machines" USING GIN ("serial_number" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "machine_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machines" ADD CONSTRAINT "machines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_status_history" ADD CONSTRAINT "machine_status_history_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "machine_status_history" ADD CONSTRAINT "machine_status_history_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
