-- 009_crm_functions — helpers for CRM segmentation (birthdays / anniversaries), leap-year safe.

CREATE FUNCTION sofia_days_until_yearly(d date) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN d IS NULL THEN NULL ELSE (
    SELECT min(x - current_date)::int FROM (
      SELECT make_date(y, extract(month FROM d)::int,
                       CASE WHEN extract(month FROM d) = 2 AND extract(day FROM d) = 29
                                 AND NOT (y % 4 = 0 AND (y % 100 <> 0 OR y % 400 = 0)) THEN 28
                            ELSE extract(day FROM d)::int END) AS x
      FROM (VALUES (extract(year FROM current_date)::int), (extract(year FROM current_date)::int + 1)) AS yrs(y)
    ) c WHERE x >= current_date
  ) END
$$;
