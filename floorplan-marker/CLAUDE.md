# Claude Code handoff

This is a LOCAL Python + vanilla-JavaScript floorplan annotation prototype, not a hosted website. Read README.md and VALIDATION.md before editing.

## User intent

Chinese-speaking architecture student wants raster floorplan structure recognition without a paid/cloud AI API. Wall centerlines are red and continue through windows. Actual door openings are yellow line segments in the closed position. Stairwell regions (including appropriate landings) are green polygons at opacity 0.5. Keep original plan pixels as the background. User must be able to correct detection and export reusable data.

## Scope and honesty

- Current engine is real heuristic computer vision, not a trained neural network.
- Do not claim the source image's coordinates are automatically recognized if they are manually traced or hardcoded. No image-specific coordinate lookup or demo-only hidden overrides.
- Do not claim recognition accuracy without independent labeled test cases and metrics.
- No API key, cloud upload, telemetry, CDN, npm build or remote dependency is required at runtime after Python dependencies are installed.
- Do not add network AI calls without the user's explicit request. Local model files must be optional, documented, and actually available before claiming an AI mode works.
- Do not regenerate the source raster to draw overlays. Preserve the image-coordinate relationship.

## Interface contract

Python `detector.detect(image: PIL.Image.Image, options: dict | None = None) -> dict`.

Return arrays `walls`, `doors`, `stairs`, and object `meta`. Lines have unique `id`, finite original-image-pixel `x1/y1/x2/y2`, `source: "auto"`, and `confidence` (heuristic score, not a probability). Polygons have `id`, `points: [[x,y], ...]`, source and confidence. Coordinates stay within [0,width] x [0,height]. Root server adds width and height.

Options currently: threshold (30..250), min_wall_length (8..500 original pixels), bridge_gap (0..80 original pixels), sensitivity (0..1). If changing options, update server validation, frontend controls, documentation and tests together.

`server.py` binds loopback only, serves an explicit path allowlist and bounds request/image sizes. Keep cross-origin/Host protections. The frontend handles imports, exports, editing, undo/redo and normalization of image orientation. Project-file schema lives in app.js; preserve backwards compatibility or bump schema version and explain migration.

## Typical next steps

1. Start the existing app and try the unannotated example. Export results before changing algorithms.
2. Inspect failure cases visually. Improve generic line grouping, door-arc evidence and stair enclosure estimation. Do not hardcode the example.
3. If adding pretrained local inference, inspect model license, categories, preprocessing and exact weight format. Add it behind a provider interface and preserve the heuristic baseline. Use the same coordinates/JSON schema.
4. Add labeled examples from different plans and report door precision/recall, wall geometric error and stair polygon overlap as appropriate. These are different tasks; a good-looking overlay is not an accuracy score.
5. Keep manual correction functional even when detection fails.

## Run and verify

Python 3.10–3.12. Install requirements into .venv, then `python server.py --open`. Tests: `python -m unittest discover -s tests -v`. Browser can access http://127.0.0.1:8765. No public deployment requested.

Check upload, auto detection, add/delete/drag, undo/redo, zoom coordinate alignment, transparent PNG handling, JSON round-trip, PNG original dimensions, SVG opacity and export after manual edits. Avoid broad refactors unless required by the requested change.
