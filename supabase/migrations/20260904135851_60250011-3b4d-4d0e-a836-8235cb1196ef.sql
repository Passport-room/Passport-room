CREATE SEQUENCE IF NOT EXISTS public.customer_code_seq START 1001;

CREATE TABLE public.visitors (
  device_id text PRIMARY KEY,
  customer_code text NOT NULL UNIQUE DEFAULT ('PR-' || nextval('public.customer_code_seq')),
  device_type text,
  browser text,
  os text,
  screen text,
  visit_count integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.visitor_events (
  id bigserial PRIMARY KEY,
  device_id text NOT NULL REFERENCES public.visitors(device_id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('visit', 'time')),
  duration_ms integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX visitor_events_device_idx ON public.visitor_events (device_id, created_at DESC);

GRANT ALL ON public.visitors TO service_role;
GRANT ALL ON public.visitor_events TO service_role;
GRANT ALL ON SEQUENCE public.customer_code_seq TO service_role;
GRANT ALL ON SEQUENCE public.visitor_events_id_seq TO service_role;

ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "no public access to visitors" ON public.visitors FOR SELECT TO authenticated USING (false);
CREATE POLICY "no public access to visitor events" ON public.visitor_events FOR SELECT TO authenticated USING (false);