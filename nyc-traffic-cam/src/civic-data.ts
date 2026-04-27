/* ──────────────────────────────────────────────────────────────────────
   civic-data.ts — shared client-side fetchers for NYC civic data.

   All endpoints below are public, CORS-enabled, and require NO API key
   for casual browser-side usage. We deliberately route around the
   Azure-gated api-portal.nyc.gov (which would force a backend proxy)
   in favor of:

   - NYC GeoSearch (Department of City Planning) for address → BIN/BBL
   - NYC Open Data / Socrata for HPD violations + complaints
   - NYC Council Legistar for upcoming public meetings + hearings
   ──────────────────────────────────────────────────────────────────── */

/* ──────────────────────────────────────── address autocomplete */

const GEOSEARCH_AUTOCOMPLETE = 'https://geosearch.planninglabs.nyc/v2/autocomplete';
const GEOSEARCH_SEARCH = 'https://geosearch.planninglabs.nyc/v2/search';

export type AddressMatch = {
  label: string;
  bin?: string;       // Building Identification Number (HPD/DOB key)
  bbl?: string;       // Borough/Block/Lot
  borough?: string;
  lat?: number;
  lng?: number;
};

type GeosearchFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    label?: string;
    name?: string;
    borough?: string;
    addendum?: { pad?: { bin?: string; bbl?: string } };
  };
};

function pickAddresses(features: GeosearchFeature[]): AddressMatch[] {
  return features
    .map((f) => {
      const p = f.properties ?? {};
      const coords = f.geometry?.coordinates;
      return {
        label: p.label ?? p.name ?? '',
        bin: p.addendum?.pad?.bin,
        bbl: p.addendum?.pad?.bbl,
        borough: p.borough,
        lng: coords?.[0],
        lat: coords?.[1],
      } as AddressMatch;
    })
    .filter((a) => a.label);
}

/* Throttled-ish autocomplete: caller is expected to debounce. */
export async function autocompleteAddress(text: string, signal?: AbortSignal): Promise<AddressMatch[]> {
  if (text.trim().length < 3) return [];
  const url = `${GEOSEARCH_AUTOCOMPLETE}?text=${encodeURIComponent(text)}&size=8`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`geosearch ${r.status}`);
  const j = (await r.json()) as { features?: GeosearchFeature[] };
  return pickAddresses(j.features ?? []);
}

/* Full search — used when the user hits Enter on a free-typed address.
   Returns the single best match (or null). */
export async function searchAddress(text: string, signal?: AbortSignal): Promise<AddressMatch | null> {
  if (text.trim().length < 3) return null;
  const url = `${GEOSEARCH_SEARCH}?text=${encodeURIComponent(text)}&size=1`;
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`geosearch ${r.status}`);
  const j = (await r.json()) as { features?: GeosearchFeature[] };
  const matches = pickAddresses(j.features ?? []);
  return matches[0] ?? null;
}

/* ──────────────────────────────────────── HPD violations + complaints */

/* HPD Housing Maintenance Code Violations (Socrata dataset wvxf-dwi5).
   Class A = non-hazardous, B = hazardous, C = immediately hazardous.
   Open dataset, no app token needed for casual use. */
const HPD_VIOLATIONS_URL = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json';

/* HPD Complaint Problems (ygpa-z7cr) — the openly-readable variant.
   The original `uwyv-629c` was moved behind a Socrata login as of
   2026, so we route around it. This dataset filters by BBL parts
   (block + lot), not BIN. */
const HPD_COMPLAINTS_URL = 'https://data.cityofnewyork.us/resource/ygpa-z7cr.json';

export type HpdViolation = {
  violationid: string;
  buildingid?: string;
  bin?: string;
  housenumber?: string;
  streetname?: string;
  apartment?: string;
  novissueddate?: string;     // notice of violation date
  inspectiondate?: string;
  novdescription?: string;
  class?: string;             // 'A' | 'B' | 'C'
  currentstatus?: string;
  currentstatusdate?: string;
  nov_type?: string;
};

export async function fetchHpdViolations(bin: string, limit = 30): Promise<HpdViolation[]> {
  if (!bin) return [];
  // Most recent NOV-issued violations first; only those still open are
  // most useful for a "what's wrong with my building right now" lookup.
  const where = `bin='${bin}'`;
  const url = `${HPD_VIOLATIONS_URL}?$where=${encodeURIComponent(where)}&$order=novissueddate%20DESC&$limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`hpd-violations ${r.status}`);
  return (await r.json()) as HpdViolation[];
}

export type HpdComplaint = {
  complaint_id: string;
  problem_id?: string;
  building_id?: string;
  borough?: string;
  house_number?: string;
  street_name?: string;
  apartment?: string;
  block?: string;
  lot?: string;
  received_date?: string;
  status_date?: string;
  type?: string;               // EMERGENCY / NON EMERGENCY
  major_category?: string;     // HEAT AND HOT WATER, PLUMBING, etc
  minor_category?: string;
  status?: string;             // OPEN / CLOSED / etc
  problem_status?: string;
};

/* Parse a BBL string ("1008350041") into its parts. Returns null if
   the input isn't 10 digits. The complaints dataset stores block/lot
   without leading zeros (e.g. "835", "41") so we strip them. */
function parseBbl(bbl: string): { borough: string; block: string; lot: string } | null {
  const m = /^(\d)(\d{5})(\d{4})$/.exec(bbl);
  if (!m) return null;
  return {
    borough: m[1],
    block: String(parseInt(m[2], 10)),
    lot: String(parseInt(m[3], 10)),
  };
}

export async function fetchHpdComplaints(bbl: string | undefined, limit = 30): Promise<HpdComplaint[]> {
  if (!bbl) return [];
  const parts = parseBbl(bbl);
  if (!parts) return [];
  // Match block + lot exactly. The dataset has no `bbl` column directly,
  // so we use the parts as-is (no leading zeros).
  const where = `block='${parts.block}' AND lot='${parts.lot}'`;
  const url = `${HPD_COMPLAINTS_URL}?$where=${encodeURIComponent(where)}&$order=received_date%20DESC&$limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) {
    // Soft-fail: the panel handles an empty list as "no data on file".
    // We don't surface 403/429 because the lookup still works for
    // violations and that's the primary signal anyway.
    return [];
  }
  return (await r.json()) as HpdComplaint[];
}

/* ──────────────────────────────────────── Council Events / hearings */

const LEGISTAR_EVENTS_URL =
  'https://webapi.legistar.com/v1/nyc/Events' +
  '?$top=20' +
  '&$orderby=EventDate%20asc' +
  '&$select=EventId,EventBodyName,EventDate,EventTime,EventLocation,EventAgendaFile,EventInSiteURL,EventComment';

export type CouncilEvent = {
  EventId: number;
  EventBodyName?: string;        // Council body / committee name
  EventDate?: string;            // ISO date
  EventTime?: string;            // 'HH:MM AM' or 'HH:MM' string
  EventLocation?: string;
  EventAgendaFile?: string;      // PDF URL
  EventInSiteURL?: string;       // Legistar event page
  EventComment?: string;         // free-form note
};

/* As of mid-2026 the Granicus Legistar Web API (webapi.legistar.com)
   started 403-ing anonymous calls. We attempt the fetch but treat any
   failure as a *soft* unavailability — the UI then renders a clean
   "view live at legistar.council.nyc.gov" link card so the page stays
   useful even when the JSON feed is gated. */
export async function fetchCouncilEvents(): Promise<CouncilEvent[] | null> {
  try {
    const r = await fetch(LEGISTAR_EVENTS_URL);
    if (!r.ok) return null;
    const all = (await r.json()) as CouncilEvent[];
    const cutoff = Date.now() - 12 * 60 * 60 * 1000;
    return all.filter((e) => {
      if (!e.EventDate) return false;
      const t = Date.parse(e.EventDate);
      if (Number.isNaN(t)) return false;
      return t >= cutoff;
    });
  } catch {
    return null;
  }
}
