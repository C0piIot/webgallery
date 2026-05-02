# Plan — Issue #29: Local thumb badge fills the ratio container

## Bug

On Local cards, the status badge spans the whole thumbnail box and hides the image. Reported during manual smoke after #28.

## Cause

Bootstrap's `.ratio` utility:

```css
.ratio > * {
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
}
```

forces *every* direct child to fill its container. `renderLocalThumb` puts both the `<img>` and the `<span class="badge ...">` as direct children of the `.ratio` div, so the badge inherits the 100%/100% sizing and the corner positioning utilities (`top-0 end-0 m-1`) get overridden by the bottom/left declarations from the selector. Last child wins paint order, so the badge ends up covering the image.

Remote tab is unaffected because its `.ratio` only has a single direct child.

## Fix

Wrap the image and badge in a single inner layer div. The layer becomes the direct child the `.ratio` selector targets; inside it, the image flows at 100%/100% and the badge is absolutely positioned relative to the layer (any `position: absolute` parent is a containing block).

```html
<div class="ratio ratio-1x1 bg-light" data-role="thumb">
  <div>  <!-- gets absolute + 100%/100% from .ratio > * -->
    <img style="width:100%;height:100%;object-fit:cover">
    <span class="badge position-absolute top-0 end-0 m-1" data-role="status"></span>
  </div>
</div>
```

Placeholder divs (video 🎬, status emoji ⏳/⚠️) need explicit `h-100 w-100` now that they're no longer direct children of `.ratio`. Add those classes to `thumbPlaceholder` — harmless on the Remote-tab callsite (which still has them as direct children of `.ratio`, where the selector already handles sizing).

`replaceWithPlaceholder` updates to operate on the inner layer div, not the outer thumb container.

## Tests

- Existing e2e selectors (`[data-role="thumb"] img`, `[data-role="status"]`) are descendant-based, so they still match through the new layer wrapper. No e2e changes required.
- No new unit tests; this is pure DOM wiring.

## Files

- `index.js` — `renderLocalThumb` adds inner layer; `replaceWithPlaceholder` operates on layer; `thumbPlaceholder` gains `h-100 w-100`.
- `sw.js` — `VERSION` v22 → v23.
- `docs/plans/README.md` — index entry for #29.

## Verification

1. `make lint` / `make test` — no unit regressions.
2. `make e2e` — passes unchanged.
3. Manual smoke at deploy: Local-tab thumbnails show full image with the status badge tucked in the top-right corner.
