# Claude Development Guide

## Your Role
You are a reasoning and explanation layer, not the quantitative engine.

## Before Building Anything
Always:
1. Read the existing design and architecture.
2. Search for an existing implementation before creating new code.
3. Verify whether the feature already exists.
4. Reuse existing abstractions.
5. Confirm the feature fits the roadmap.

## Before Every Commit
- Check for duplicate logic.
- Verify types compile.
- Confirm UI and backend stay consistent.
- Ensure calculations remain deterministic.
- Run existing validation/tests where possible.

## Feature Priority Order
1. Claude explanation UI.
2. Calibrated Expected Value (EV).
3. Confidence scoring.
4. External context (Reddit/Discord).
5. Feature attribution.
6. Lightweight regime detection.
7. ML ranking only after sufficient historical data.

## Engineering Rules
- Never replace deterministic calculations with AI.
- Keep business logic explainable.
- Add telemetry where new scoring is introduced.
- Favor simple, maintainable solutions.
- If uncertain, stop and inspect the existing implementation before expanding it.

## Definition of Done
A feature is complete only if:
- Code is clean and documented.
- Existing behavior is not regressed.
- Results are historically validated where applicable.
- The implementation is simpler than the alternative.
