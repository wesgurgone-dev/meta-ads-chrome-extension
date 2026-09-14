/**
 * The refracting surface, shared by the panel and the dashboard.
 *
 * Refraction is not a prop: the displacement map is generated for one exact
 * size and corner radius, so the element has to be measured, the map built,
 * the filter rendered, and only then can Glass reference it by id.
 *
 * The lens is an empty Glass layer and the content is a sibling above it,
 * because Chromium applies an SVG filter to the element itself rather than to
 * its backdrop. On a surface holding text, a single layer displaces the text
 * along with the background behind it.
 */
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Glass, SdfFilterDefinition, useSdfFilter } from "open-glass-ui";
import { getMaterialPreset } from "open-glass-ui/core";

/**
 * SDF refraction is off by default, and that is a measured decision rather
 * than a preference.
 *
 * Rendered in Chromium on a rectangular UI surface, the library's sdf-svg
 * renderer does not bend the backdrop: it replaces it. An A/B on one stat tile,
 * same element, filter toggled, gives clean glass with the ground showing
 * through when the filter is off and a flat grey slab with a chromatic rim when
 * it is on. The map, the optics and the geometry are all correct by then, so
 * this is the renderer's output, not our wiring, which is presumably why the
 * library gates it behind an explicit opt-in and defaults renderer="auto".
 *
 * The plumbing stays because it is correct and cheap: measure, generate, render
 * the filter, reference it. Pass refract to switch it on for a surface and see
 * for yourself, and revisit when the renderer or Chromium moves.
 */
const REFRACT_MAX_SPAN = 420;

export const Surface = ({
  material = "clear",
  className = "",
  radius = 18,
  refract = false,
  children,
  style,
  ...rest
}) => {
  const ref = useRef(null);
  const id = useId().replace(/:/g, "");
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const r = node.getBoundingClientRect();
      setSize((prev) =>
        Math.round(prev.width) === Math.round(r.width) &&
        Math.round(prev.height) === Math.round(r.height)
          ? prev
          : { width: r.width, height: r.height },
      );
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);

  const width = Math.round(size.width);
  const height = Math.round(size.height);

  // Without this the map is built from the library's default optics while the
  // surface paints a different preset, so the displacement never matches the
  // material: the whole rectangle shifts instead of the rim bending. The
  // thickness field is what makes the core bend and the perimeter catch light.
  const preset = getMaterialPreset(material);

  // The presets are tuned for the library's demo, where the glass is a blob a
  // couple of hundred pixels across. On a 1000px-wide bar the same dispersion
  // stops reading as glass and starts reading as a coloured outline, because
  // the rim is the only part of a large flat pane that bends at all. So damp
  // dispersion and thickness as the surface grows; small controls keep the
  // full effect.
  const span = Math.max(width, height);

  // Refraction is a lens effect, and a lens only reads as one at a size the eye
  // can take in whole. On a 1000px pane the rim is the only part that bends, so
  // the filter contributes a coloured outline and a grey wash and nothing else.
  // Above the threshold the surface keeps the plain CSS material, which is also
  // what Apple's own guidance says: large surfaces should read as thicker
  // material, not as optics.
  const lensed = refract && span > 0 && span <= REFRACT_MAX_SPAN;

  const damp = Math.min(1, 260 / Math.max(span, 1));
  const optics = {
    ...preset,
    dispersion: preset.dispersion * (0.12 + 0.88 * damp),
    thickness: preset.thickness * (0.3 + 0.7 * damp),
    edgeStrength: preset.edgeStrength * (0.5 + 0.5 * damp),
  };

  const filter = useSdfFilter({
    id: `ogui-${id}`,
    // Zero size skips generation entirely for panes that will never use it.
    width: lensed ? width : 0,
    height: lensed ? height : 0,
    geometry: { kind: "rounded-rect", width, height, cornerRadius: radius },
    material: optics,
    quality: "high",
  });

  return (
    <div
      ref={ref}
      className={`surface ${className}`.trim()}
      style={{ ...style, borderRadius: radius }}
      {...rest}
    >
      <SdfFilterDefinition filter={filter} />
      <Glass
        aria-hidden="true"
        className="surface-lens"
        material={material}
        renderer={lensed && filter.ready ? "sdf-svg" : "auto"}
        filterId={lensed && filter.ready ? filter.filterId : undefined}
        style={{ borderRadius: radius }}
      />
      <div className="surface-content">{children}</div>
    </div>
  );
};
