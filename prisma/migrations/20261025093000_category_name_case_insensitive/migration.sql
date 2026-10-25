-- Category names are normalized by the application and must remain unique regardless of case.
CREATE UNIQUE INDEX "machine_categories_name_lower_key"
ON "machine_categories" (lower("name"));
