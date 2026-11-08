// A handful of stroke icons (24px grid, drawn with currentColor) so buttons don't depend on unicode glyphs.
const PATHS = {
  code: "M8 7l-5 5 5 5M16 7l5 5-5 5",
  chart: "M3 20h18M6 16v-5M11 16V6M16 16v-8M21 16V9",
  market: "M3 17l6-6 4 4 7-7M15 8h5v5",
  shield: "M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6zM9 12l2 2 4-4",
  check: "M5 12.5l4.5 4.5L19 7",
  chevron: "M9 6l6 6-6 6",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z",
  x: "M6 6l12 12M18 6L6 18",
} as const;

export type IconName = keyof typeof PATHS | "clock";

export default function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg className="ico" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {name === "clock" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      ) : (
        <path d={PATHS[name]} />
      )}
    </svg>
  );
}
