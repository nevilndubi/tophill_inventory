-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW');

-- Required for equality on UUID inside the GiST exclusion constraint.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_until" TIMESTAMPTZ(3) NOT NULL,
    "status" "booking_status" NOT NULL,
    "purpose" TEXT NOT NULL,
    "approved_by_user_id" UUID,
    "decision_note" TEXT,
    "cancelled_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "booking_id" UUID,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "expected_end_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "purpose" TEXT NOT NULL,
    "end_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_sessions_pkey" PRIMARY KEY ("id")
);

-- Booking windows and purpose text are constrained for every writer.
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_ends_after_starts_check"
        CHECK ("ends_at" > "starts_at"),
    ADD CONSTRAINT "bookings_blocked_until_not_before_ends_check"
        CHECK ("blocked_until" >= "ends_at"),
    ADD CONSTRAINT "bookings_purpose_length_check"
        CHECK (char_length("purpose") <= 200);

-- Usage sessions are factual records with monotonic time boundaries.
ALTER TABLE "usage_sessions"
    ADD CONSTRAINT "usage_sessions_ended_at_not_before_started_at_check"
        CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at"),
    ADD CONSTRAINT "usage_sessions_expected_end_after_started_at_check"
        CHECK ("expected_end_at" IS NULL OR "expected_end_at" > "started_at"),
    ADD CONSTRAINT "usage_sessions_purpose_length_check"
        CHECK (char_length("purpose") <= 200);

-- CreateIndex
CREATE INDEX "bookings_machine_id_starts_at_idx" ON "bookings"("machine_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_requested_by_user_id_starts_at_idx" ON "bookings"("requested_by_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "bookings_status_starts_at_idx" ON "bookings"("status", "starts_at");

-- CreateIndex
CREATE INDEX "usage_sessions_user_id_started_at_idx" ON "usage_sessions"("user_id", "started_at");

-- A machine can have at most one open session.
CREATE UNIQUE INDEX "usage_sessions_one_open_per_machine"
ON "usage_sessions"("machine_id")
WHERE "ended_at" IS NULL;

-- A booking can be linked to at most one usage session.
CREATE UNIQUE INDEX "usage_sessions_one_per_booking"
ON "usage_sessions"("booking_id")
WHERE "booking_id" IS NOT NULL;

-- Active bookings reserve the half-open interval through the stored buffer snapshot.
ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_no_overlap"
    EXCLUDE USING gist (
        "machine_id" WITH =,
        tstzrange("starts_at", "blocked_until", '[)') WITH &&
    )
    WHERE ("status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS'));

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_sessions" ADD CONSTRAINT "usage_sessions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_sessions" ADD CONSTRAINT "usage_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_sessions" ADD CONSTRAINT "usage_sessions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
