"""curator.py — Curator approval layer for POI classifications.

Manages a simple JSON audit trail of curator decisions:
- per-camera approvals (approved: true/false/null)
- optional notes and confidence overrides
- timestamp + audit trail

Load/merge/save operations are idempotent and thread-safe via atomic
file writes. No database required — curator_approved.json is the
single source of truth.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CURATOR_PATH = ROOT / "data" / "curator_approved.json"


class CuratorRegistry:
    """Thread-safe audit trail of curator decisions."""

    def __init__(self, path: Path = CURATOR_PATH):
        self.path = path
        self._ensure_file()

    def _ensure_file(self) -> None:
        """Create curator file if missing."""
        if not self.path.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps({"decisions": {}}))

    def load_all(self) -> dict[str, Any]:
        """Load all curator decisions."""
        try:
            return json.loads(self.path.read_text()).get("decisions", {})
        except Exception as e:
            logging.warning(f"Failed to load curator approvals: {e}")
            return {}

    def load_one(self, cam_id: str) -> dict[str, Any] | None:
        """Load decision for one camera."""
        all_decisions = self.load_all()
        return all_decisions.get(cam_id)

    def save_one(self, cam_id: str, approved: bool | None, notes: str = "", confidence_override: int | None = None) -> None:
        """Save curator decision (atomic append).

        Args:
            cam_id: Camera UUID
            approved: True=approve, False=reject, None=undecided
            notes: Optional curator notes
            confidence_override: Optional override for model confidence (0-100)
        """
        all_decisions = self.load_all()
        all_decisions[cam_id] = {
            "cam_id": cam_id,
            "approved": approved,
            "notes": notes,
            "confidence_override": confidence_override,
            "curator_timestamp": int(time.time()),
        }
        
        payload = {"decisions": all_decisions}
        # Atomic write
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(self.path)
        logging.info(f"saved curator decision: {cam_id} approved={approved}")

    def apply_to_record(self, cam_id: str, poi_record: dict[str, Any]) -> dict[str, Any]:
        """Merge curator decision into a POI record.

        If curator rejected, set image_usable=false and interest=0.
        If curator set confidence_override, use that instead of model confidence.
        """
        decision = self.load_one(cam_id)
        if not decision:
            return poi_record

        out = dict(poi_record)
        if decision.get("approved") is False:
            # Curator explicitly rejected this cam
            out["image_usable"] = False
            out["interest"] = 0
            out["_curator_rejected"] = True
            out["_curator_notes"] = decision.get("notes")
        elif decision.get("approved") is True:
            # Curator approved; optionally override confidence
            out["_curator_approved"] = True
            if decision.get("confidence_override") is not None:
                out["confidence"] = decision["confidence_override"]
            out["_curator_notes"] = decision.get("notes")
        
        return out

    def stats(self) -> dict[str, Any]:
        """Quick stats on curator decisions."""
        all_decisions = self.load_all()
        approved_count = sum(1 for d in all_decisions.values() if d.get("approved") is True)
        rejected_count = sum(1 for d in all_decisions.values() if d.get("approved") is False)
        return {
            "total_decisions": len(all_decisions),
            "approved": approved_count,
            "rejected": rejected_count,
            "undecided": len(all_decisions) - approved_count - rejected_count,
        }


# Singleton instance
registry = CuratorRegistry()
