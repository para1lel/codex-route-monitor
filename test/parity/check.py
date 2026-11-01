#!/usr/bin/env python3
"""Records ModelTrace's own answer for the parity fixture.

    MODELTRACE_DIR=/path/to/ModelTrace python test/parity/check.py

The result goes to test/parity/expected.json, where the Node test compares it
with this package's JavaScript port. Only a developer needs this; `npm test`
reads the committed file.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get("MODELTRACE_DIR", "ModelTrace")).resolve()
sys.path.insert(0, str(SOURCE))

import fingerprint  # noqa: E402  (from the ModelTrace checkout)

inputs = json.loads((HERE / "inputs.json").read_text(encoding="utf-8"))
bank = json.loads((SOURCE / "data" / "unified_bank.json").read_text(encoding="utf-8"))

out = {}
for name, outputs in inputs.items():
    result = fingerprint.analyze_global_outputs(outputs, bank)
    out[name] = {
        "prediction": result["prediction"],
        "prediction_name": result["prediction_name"],
        "probability": result["probability"],
        "used_outputs": result["used_outputs"],
        "calibration": result["calibration"],
        "family_prediction": result["family_prediction"],
        "family_probability": result["family_probability"],
        "results": [
            {
                "model": item["model"],
                "probability": item["probability"],
                "score": item["score"],
                "profile_similarity": item["profile_similarity"],
                "conditional_probability": item["conditional_probability"],
            }
            for item in result["results"]
        ],
        "diagnostics": result["diagnostics"],
    }

(HERE / "expected.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
print(f"wrote {HERE / 'expected.json'}")
