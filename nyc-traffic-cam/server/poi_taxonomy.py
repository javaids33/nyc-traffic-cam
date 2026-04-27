"""poi_taxonomy.py — single source of truth for the cam classifier.

Holds the prompt, the response schema, and the parser shared by both
poi_classify_local.py (Ollama) and poi_classify.py (Anthropic).

The taxonomy was rewritten 2026-04 after a hands-on review of ~22 cam
frames showed the original 8-class POI prompt (bridge / landmark /
park / waterway / tunnel / iconic / skyline / intersection) was a
poor fit for the actual corpus:

  - "bodega" was unresolvable at 352x240
  - "landmark" / "iconic" were too rare or too fuzzy to train against
  - 15% of cams produce unusable frames (sun glare, mispointed,
    frozen on infrastructure) — that's a class in itself
  - The genuinely interesting signal is event-like (crowd, tents,
    cones) and state-like (weather, congestion), not point-of-interest

The new schema is a 14-field structured record split into four
buckets — scene type, quality flags, time/weather/congestion state,
and event detection. Each ships with its own controlled vocabulary
so a small VLM can stay on rails.

Backward compatibility: to_record() always emits the legacy poi /
category / description / confidence fields the existing src/poi.tsx
page reads, derived from the new fields. The on-disk cam_pois.json
shape is a strict superset of the old shape — older consumers keep
working unchanged.
"""
from __future__ import annotations

import json
from typing import Any

# ── Controlled vocabularies ─────────────────────────────────────────
SCENE_VALUES = {
    "highway",       # multi-lane divided road, expressway/parkway
    "bridge",        # girders/cables/water visible
    "tunnel",        # tunnel mouth or approach
    "intersection",  # cross-street with peds + signals
    "boulevard",     # commercial strip, storefronts
    "residential",   # brownstones, parked cars, side street
    "skyline",       # primary subject IS the cityscape
    "other",         # anything else
}
TIME_OF_DAY_VALUES = {"day", "dusk", "dawn", "night"}
WEATHER_VALUES = {"clear", "wet", "snow", "fog"}
CONGESTION_VALUES = {"empty", "light", "busy", "jammed"}

# Map new scene → legacy /poi page category. The /poi page only
# renders cams whose category is one of: bridge, landmark, park,
# waterway, tunnel, iconic, skyline, intersection. We map our scenes
# onto that set so the existing UI keeps lighting up.
_SCENE_TO_LEGACY_CATEGORY = {
    "bridge":       "bridge",
    "tunnel":       "tunnel",
    "intersection": "intersection",
    "skyline":      "skyline",
    "highway":      "iconic",
    "boulevard":    "iconic",
    "residential":  "iconic",
    "other":        None,
}


PROMPT = """\
You are looking at a still frame from a NYC DOT traffic camera.
The image is roughly 352x240 pixels with a timestamp burn-in at
the top of the frame. Be conservative: if unsure, prefer
null/false and lower the confidence rather than guess.

Output ONE JSON object with these exact fields and no other text:

{
  "image_usable": <bool — false if the frame is blown out by sun,
                   covered by water/dirt/smudge on the lens, pointed
                   at empty pavement or just bridge railings, or
                   otherwise unusable>,
  "scene": <one of: "highway", "bridge", "tunnel", "intersection",
                    "boulevard", "residential", "skyline", "other">,
  "skyline_visible": <bool — true if Manhattan skyline silhouette
                      is visible in the distance, even from a cam
                      that isn't primarily a skyline shot>,
  "sun_glare": <bool — true if significant glare or lens-flare>,
  "lens_obstruction": <bool — water droplets, dirt, smudge on lens>,
  "time_of_day": <one of: "day", "dusk", "dawn", "night">,
  "weather": <one of: "clear", "wet", "snow", "fog">,
  "congestion": <one of: "empty", "light", "busy", "jammed">,
  "crowd_or_event": <bool — true if 5+ pedestrians clustered, tents
                     or vendor booths, road work / cones / barriers,
                     or any unusual gathering>,
  "event_description": <if crowd_or_event is true, an 8-word
                        description; else null>,
  "landmark_name": <if a recognizable NYC landmark is clearly in
                    frame (Brooklyn Bridge, Empire State, Citi Field,
                    Barclays Center, etc.), name it; else null>,
  "confidence": <integer 0-100, your overall confidence>
}
"""


def _coerce_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "yes", "1", "y"}
    return bool(v)


def _coerce_str_enum(v: Any, allowed: set[str], default: str | None = None) -> str | None:
    if v is None:
        return default
    s = str(v).strip().lower()
    return s if s in allowed else default


def _coerce_str_or_none(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def parse_response(text: str) -> dict[str, Any]:
    """Parse a model's JSON response into the canonical record shape.

    Tolerant of:
      - ```json fenced code blocks
      - extra prose before/after the JSON
      - missing fields (filled with safe defaults)
      - wrong types (coerced; falls back to defaults if uncoercible)

    Always returns a dict with every field set. Adds a `_parse_error`
    when the JSON itself was unrecoverable.
    """
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()

    parsed: dict[str, Any] | None = None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        # Last resort: find the first { ... } block in the string.
        l = raw.find("{")
        r = raw.rfind("}")
        if l != -1 and r > l:
            try:
                parsed = json.loads(raw[l : r + 1])
            except json.JSONDecodeError:
                parsed = None

    if not isinstance(parsed, dict):
        return {
            **_empty_record(),
            "_parse_error": (text or "")[:200],
        }

    return {
        "image_usable":      _coerce_bool(parsed.get("image_usable", True)),
        "scene":             _coerce_str_enum(parsed.get("scene"), SCENE_VALUES, "other"),
        "skyline_visible":   _coerce_bool(parsed.get("skyline_visible", False)),
        "sun_glare":         _coerce_bool(parsed.get("sun_glare", False)),
        "lens_obstruction":  _coerce_bool(parsed.get("lens_obstruction", False)),
        "time_of_day":       _coerce_str_enum(parsed.get("time_of_day"), TIME_OF_DAY_VALUES, "day"),
        "weather":           _coerce_str_enum(parsed.get("weather"), WEATHER_VALUES, "clear"),
        "congestion":        _coerce_str_enum(parsed.get("congestion"), CONGESTION_VALUES, "empty"),
        "crowd_or_event":    _coerce_bool(parsed.get("crowd_or_event", False)),
        "event_description": _coerce_str_or_none(parsed.get("event_description")),
        "landmark_name":     _coerce_str_or_none(parsed.get("landmark_name")),
        "confidence":        _clamp_int(parsed.get("confidence"), 0, 100, 0),
    }


def _clamp_int(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def _empty_record() -> dict[str, Any]:
    return {
        "image_usable": False,
        "scene": "other",
        "skyline_visible": False,
        "sun_glare": False,
        "lens_obstruction": False,
        "time_of_day": "day",
        "weather": "clear",
        "congestion": "empty",
        "crowd_or_event": False,
        "event_description": None,
        "landmark_name": None,
        "confidence": 0,
    }


# ── Interest score ──────────────────────────────────────────────────
# A 0-100 ranking of "how visually/news-worthy is this cam right now"
# derived purely from the structured fields. Computed at bake time
# and shipped in cam-pois.json so the frontend can sort instantly.
#
# Weights are tuned so the typical highway + clear day + light traffic
# scores near 0; a bridge with skyline at dusk scores ~20-30; a
# crowd/event on a rainy night with a landmark in frame scores 70+.

_SCENE_BONUS = {
    "skyline":      12,   # primary subject is the cityscape — striking
    "tunnel":       12,   # rare and visually distinctive
    "bridge":       10,
    "intersection":  4,
    "boulevard":     3,
    "residential":   2,
    "highway":       0,   # baseline
    "other":        -5,
}
_WEATHER_BONUS = {"snow": 25, "fog": 15, "wet": 10, "clear": 0}
_TIME_BONUS    = {"night": 10, "dawn": 8, "dusk": 4, "day": 0}
_CONG_BONUS    = {"jammed": 12, "busy": 5, "light": 0, "empty": -3}


def interest_score(rec: dict[str, Any]) -> int:
    """Compute a 0-100 interest score from a parsed/canonical record.

    Returns 0 for any frame flagged image_usable=false — broken cams
    should never bubble up regardless of their other fields.

    Confidence acts as a multiplier so low-confidence guesses can't
    dominate the leaderboard with phantom events.
    """
    if not rec.get("image_usable", True):
        return 0

    score = 0.0

    # Quality penalties — visible artifacts lower the rank
    if rec.get("sun_glare"):
        score -= 20
    if rec.get("lens_obstruction"):
        score -= 30

    # Event payload — the gold. A real crowd/event is the biggest signal.
    if rec.get("crowd_or_event"):
        score += 35
    if rec.get("landmark_name"):
        score += 18

    # Scene-type visual rarity
    score += _SCENE_BONUS.get(rec.get("scene") or "other", 0)
    if rec.get("skyline_visible") and rec.get("scene") != "skyline":
        score += 8

    # Atmospheric / temporal interest
    score += _WEATHER_BONUS.get(rec.get("weather") or "clear", 0)
    score += _TIME_BONUS.get(rec.get("time_of_day") or "day", 0)
    score += _CONG_BONUS.get(rec.get("congestion") or "empty", 0)

    # Confidence multiplier so a 30%-confident "event" can't outrank
    # a 90%-confident landmark shot.
    confidence = rec.get("confidence", 0) or 0
    score *= max(0.0, min(1.0, confidence / 100.0))

    return max(0, min(100, int(round(score))))


def to_record(
    parsed: dict[str, Any],
    *,
    lat: float | None = None,
    lng: float | None = None,
) -> dict[str, Any]:
    """Wrap a parsed response into the on-disk cam record.

    Adds the legacy poi / category / description fields so the
    existing /poi page keeps working without changes — they're
    derived from the new structured fields. Also computes a
    moment-in-time `interest` score the frontend uses to rank
    "what's worth looking at right now".
    """
    out = dict(parsed)

    # Legacy fields, derived. Priority for `poi`/`description`:
    #   landmark_name > event_description > scene-flavored phrase
    landmark = out.get("landmark_name")
    event = out.get("event_description")
    scene = out.get("scene")

    if landmark:
        legacy_poi = landmark
        legacy_desc = landmark
        # If we have a landmark, prefer the more specific category
        # buckets the /poi page already renders.
        legacy_cat = _scene_or_skyline_category(scene, out.get("skyline_visible", False))
    elif event:
        legacy_poi = event
        legacy_desc = event
        legacy_cat = _scene_or_skyline_category(scene, out.get("skyline_visible", False))
    else:
        legacy_cat = _scene_or_skyline_category(scene, out.get("skyline_visible", False))
        legacy_poi = legacy_cat
        legacy_desc = _flavor_phrase(out)

    # If the frame is unusable, suppress legacy surfacing entirely so
    # the /poi page doesn't render a card for a broken cam.
    if not out.get("image_usable", True):
        legacy_poi = None
        legacy_cat = None
        legacy_desc = None

    out["poi"] = legacy_poi
    out["category"] = legacy_cat
    out["description"] = legacy_desc
    out["interest"] = interest_score(out)
    if lat is not None:
        out["_lat"] = lat
    if lng is not None:
        out["_lng"] = lng
    return out


def _scene_or_skyline_category(scene: str | None, skyline_visible: bool) -> str | None:
    # A cam tagged scene=intersection but with skyline_visible=True
    # still belongs in the intersection bucket — skyline is a bonus.
    # But scene=other with skyline_visible=True should ride in the
    # skyline bucket.
    base = _SCENE_TO_LEGACY_CATEGORY.get(scene or "other")
    if base is None and skyline_visible:
        return "skyline"
    return base


def _flavor_phrase(rec: dict[str, Any]) -> str:
    """Lightweight 'description' for cams without a landmark/event."""
    bits: list[str] = []
    cong = rec.get("congestion")
    weather = rec.get("weather")
    scene = rec.get("scene")
    tod = rec.get("time_of_day")
    if cong and cong != "empty":
        bits.append(cong)
    if weather and weather != "clear":
        bits.append(weather)
    if scene and scene != "other":
        bits.append(scene)
    if tod and tod != "day":
        bits.append(f"at {tod}")
    return " ".join(bits) or "quiet street"


def empty_skipped_record(reason: str) -> dict[str, Any]:
    """Record for cams we couldn't even fetch an image for."""
    return {
        **_empty_record(),
        "poi": None,
        "category": None,
        "description": None,
        "interest": 0,
        "_skipped": reason,
    }


def empty_error_record(err: str) -> dict[str, Any]:
    """Record for cams whose classification call raised."""
    return {
        **_empty_record(),
        "poi": None,
        "category": None,
        "description": None,
        "interest": 0,
        "_error": err[:200],
    }
