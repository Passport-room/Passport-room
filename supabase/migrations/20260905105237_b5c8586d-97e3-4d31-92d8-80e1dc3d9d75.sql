CREATE TABLE IF NOT EXISTS public.admin_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password text NOT NULL
);
ALTER TABLE public.admin_config ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.admin_config TO service_role;

INSERT INTO public.admin_config (id, password)
VALUES (1, 'PassportRoom-Admin-2026')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.track_visit(
  p_device_id text,
  p_device_type text DEFAULT NULL,
  p_browser text DEFAULT NULL,
  p_os text DEFAULT NULL,
  p_screen text DEFAULT NULL,
  p_event text DEFAULT 'visit',
  p_duration_ms integer DEFAULT 0
)
RETURNS TABLE (customer_code text, visits integer, total_ms bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_event text := CASE WHEN p_event = 'time' THEN 'time' ELSE 'visit' END;
  v_ms integer := LEAST(GREATEST(COALESCE(p_duration_ms, 0), 0), 21600000);
BEGIN
  IF p_device_id IS NULL OR length(p_device_id) < 8 OR length(p_device_id) > 80 THEN
    RAISE EXCEPTION 'invalid device id';
  END IF;

  INSERT INTO public.visitors AS v (device_id, device_type, browser, os, screen, visit_count, total_ms)
  VALUES (
    p_device_id,
    left(p_device_type, 20), left(p_browser, 40), left(p_os, 40), left(p_screen, 20),
    CASE WHEN v_event = 'visit' THEN 1 ELSE 0 END,
    v_ms
  )
  ON CONFLICT (device_id) DO UPDATE SET
    device_type = COALESCE(left(p_device_type, 20), v.device_type),
    browser = COALESCE(left(p_browser, 40), v.browser),
    os = COALESCE(left(p_os, 40), v.os),
    screen = COALESCE(left(p_screen, 20), v.screen),
    visit_count = v.visit_count + CASE WHEN v_event = 'visit' THEN 1 ELSE 0 END,
    total_ms = v.total_ms + v_ms,
    last_seen_at = now();

  INSERT INTO public.visitor_events (device_id, event_type, duration_ms)
  VALUES (p_device_id, v_event, v_ms);

  RETURN QUERY
  SELECT v2.customer_code, v2.visit_count, v2.total_ms
  FROM public.visitors v2
  WHERE v2.device_id = p_device_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_visitors(p_password text)
RETURNS TABLE (
  customer_code text,
  device_type text,
  browser text,
  os text,
  screen text,
  visit_count integer,
  total_ms bigint,
  first_seen_at timestamptz,
  last_seen_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn2$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.admin_config c WHERE c.id = 1 AND c.password = COALESCE(p_password, '')
  ) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  SELECT v.customer_code, v.device_type, v.browser, v.os, v.screen,
         v.visit_count, v.total_ms, v.first_seen_at, v.last_seen_at
  FROM public.visitors v
  ORDER BY v.last_seen_at DESC
  LIMIT 500;
END;
$fn2$;

REVOKE ALL ON FUNCTION public.track_visit(text, text, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_visitors(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_visit(text, text, text, text, text, text, integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_visitors(text) TO anon, authenticated, service_role;