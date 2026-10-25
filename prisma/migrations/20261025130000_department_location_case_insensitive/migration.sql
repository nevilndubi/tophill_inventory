-- Task 3.2 reviewed additive uniqueness hardening.
-- These expression indexes enforce the API's normalized case-insensitive names and codes.
CREATE UNIQUE INDEX "departments_name_ci_key" ON "departments" (lower("name"));
CREATE UNIQUE INDEX "departments_code_ci_key" ON "departments" (lower("code"));
CREATE UNIQUE INDEX "locations_department_id_name_ci_key"
  ON "locations" ("department_id", lower("name"));
