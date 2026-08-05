# Project Roadmap (Human)

## Immediate Priorities
1. Fund Anthropic API and verify Claude integration.
2. Finish Claude UI in the item modal.
3. Build Calibrated Expected Value (EV) using Track Record history.
4. Grow historical dataset for manipulation detection and recommendation calibration.

## Development Principles
- Keep deterministic calculations outside the LLM.
- Treat Claude as a reasoning layer, never the source of truth.
- Ship features only after validating them with historical data.
- Prefer measurable improvements over feature count.

## Medium-Term Features
- Reddit sentiment
- Discord monitoring
- Confidence intervals
- Position sizing
- Lightweight market regime classification
- Feature attribution ("why did this score change?")

## Long-Term
- Learning-to-rank ML model.
- Probability calibration.
- Continuous evaluation against Track Record.
