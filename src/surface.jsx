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

export const Surface = ({
  material = "clear",
  className = "",
  radius = 18,
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
  const filter = useSdfFilter({
    id: `ogui-${id}`,
    width,
    height,
    geometry: { kind: "rounded-rect", width, height, cornerRadius: radius },
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
        renderer={filter.ready ? "sdf-svg" : "auto"}
        filterId={filter.ready ? filter.filterId : undefined}
        style={{ borderRadius: radius }}
      />
      <div className="surface-content">{children}</div>
    </div>
  );
};
