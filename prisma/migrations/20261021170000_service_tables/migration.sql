-- CreateEnum
CREATE TYPE "service_ticket_severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "service_ticket_status" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "service_ticket_type" AS ENUM ('FAULT', 'PREVENTIVE', 'CALIBRATION', 'INSPECTION');

-- CreateTable
CREATE TABLE "service_tickets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "reported_by_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "service_ticket_severity" NOT NULL,
    "status" "service_ticket_status" NOT NULL DEFAULT 'OPEN',
    "assigned_to_user_id" UUID,
    "type" "service_ticket_type" NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "machine_out_of_service_from" TIMESTAMPTZ(3),
    "machine_back_in_service_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_records" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ticket_id" UUID NOT NULL,
    "performed_by_user_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(3) NOT NULL,
    "work_done" TEXT NOT NULL,
    "parts_replaced" TEXT,
    "cost_amount" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "next_due_at" TIMESTAMPTZ(3),
    "vendor_name" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "interval_days" INTEGER NOT NULL,
    "last_done_at" TIMESTAMPTZ(3),
    "next_due_at" TIMESTAMPTZ(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id")
);

-- Ticket lifecycle and text invariants are enforced for every database writer.
ALTER TABLE "service_tickets"
    ADD CONSTRAINT "service_tickets_title_length_check"
        CHECK (char_length("title") BETWEEN 1 AND 200),
    ADD CONSTRAINT "service_tickets_title_not_blank_check"
        CHECK (btrim("title") <> ''),
    ADD CONSTRAINT "service_tickets_description_length_check"
        CHECK (char_length("description") <= 4000),
    ADD CONSTRAINT "service_tickets_resolved_status_timestamp_check"
        CHECK ("status" NOT IN ('RESOLVED', 'CLOSED') OR "resolved_at" IS NOT NULL),
    ADD CONSTRAINT "service_tickets_closed_status_timestamp_check"
        CHECK ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL),
    ADD CONSTRAINT "service_tickets_resolved_at_order_check"
        CHECK ("resolved_at" IS NULL OR "resolved_at" >= "opened_at"),
    ADD CONSTRAINT "service_tickets_closed_at_order_check"
        CHECK ("closed_at" IS NULL OR ("resolved_at" IS NOT NULL AND "closed_at" >= "resolved_at")),
    ADD CONSTRAINT "service_tickets_service_window_order_check"
        CHECK (
            "machine_out_of_service_from" IS NULL
            OR "machine_back_in_service_at" IS NULL
            OR "machine_back_in_service_at" >= "machine_out_of_service_from"
        ),
    ADD CONSTRAINT "service_tickets_assignment_required_check"
        CHECK ("status" NOT IN ('ASSIGNED', 'IN_PROGRESS') OR "assigned_to_user_id" IS NOT NULL);

-- Service work uses integer minor units and ISO-style currency codes.
ALTER TABLE "service_records"
    ADD CONSTRAINT "service_records_cost_amount_nonnegative_check"
        CHECK ("cost_amount" IS NULL OR "cost_amount" >= 0),
    ADD CONSTRAINT "service_records_next_due_after_performed_check"
        CHECK ("next_due_at" IS NULL OR "next_due_at" > "performed_at"),
    ADD CONSTRAINT "service_records_currency_format_check"
        CHECK ("currency" ~ '^[A-Z]{3}$');

-- Maintenance cadence and completion timestamps must remain monotonic.
ALTER TABLE "maintenance_schedules"
    ADD CONSTRAINT "maintenance_schedules_interval_days_positive_check"
        CHECK ("interval_days" > 0),
    ADD CONSTRAINT "maintenance_schedules_next_due_not_before_last_done_check"
        CHECK (
            "last_done_at" IS NULL
            OR "next_due_at" IS NULL
            OR "next_due_at" >= "last_done_at"
        );

-- CreateIndex
CREATE INDEX "service_tickets_machine_id_status_idx" ON "service_tickets"("machine_id", "status");

-- CreateIndex
CREATE INDEX "service_tickets_assigned_to_user_id_status_idx" ON "service_tickets"("assigned_to_user_id", "status");

-- CreateIndex
CREATE INDEX "service_tickets_status_severity_idx" ON "service_tickets"("status", "severity");

-- CreateIndex
CREATE INDEX "service_tickets_machine_id_opened_at_idx" ON "service_tickets"("machine_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "service_records_ticket_id_performed_at_idx" ON "service_records"("ticket_id", "performed_at");

-- A machine may retain old schedules, but only one may be active.
CREATE UNIQUE INDEX "maintenance_schedules_one_active_per_machine"
ON "maintenance_schedules"("machine_id")
WHERE "is_active";

-- Supports the active due-service sweep without indexing inactive rows.
CREATE INDEX "maintenance_schedules_active_next_due_at_idx"
ON "maintenance_schedules"("next_due_at")
WHERE "is_active";

-- CreateIndex
CREATE INDEX "machine_status_history_ticket_id_idx" ON "machine_status_history"("ticket_id");

-- AddForeignKey
ALTER TABLE "machine_status_history" ADD CONSTRAINT "machine_status_history_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_tickets" ADD CONSTRAINT "service_tickets_assigned_to_user_id_fkey" FOREIGN KEY ("assigned_to_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "service_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_records" ADD CONSTRAINT "service_records_performed_by_user_id_fkey" FOREIGN KEY ("performed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
