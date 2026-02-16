import { HILL_RIGHT, HILL_LEFT, HILL_FRONT, HILL_TRACE_TRANSFORM } from './hill-paths';

interface HillLogoProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  lightColor?: string;
  darkColor?: string;
}

export default function HillLogo({
  width = 120,
  height,
  className = '',
  lightColor = '#60757D',
  darkColor = '#3C4A52',
}: HillLogoProps) {
  return (
    <svg
      viewBox="0 0 660 297"
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Hill90 logo"
    >
      <defs>
        <linearGradient id="hill90-light-grad" x1="0" y1="0" x2="660" y2="297" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7A8E96" />
          <stop offset="100%" stopColor={lightColor} />
        </linearGradient>
        <linearGradient id="hill90-front-grad" x1="240" y1="110" x2="660" y2="297" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4C5A63" />
          <stop offset="100%" stopColor={darkColor} />
        </linearGradient>
        <clipPath id="hill90-corner-clip" clipPathUnits="userSpaceOnUse">
          <path d="M0 0 H660 V287 Q660 297 650 297 H10 Q0 297 0 287 Z" />
        </clipPath>
      </defs>
      <g clipPath="url(#hill90-corner-clip)">
        {/* Right peak (background, taller) — left edge follows gap boundary */}
        <path
          className="hill-right"
          d={HILL_RIGHT}
          transform={HILL_TRACE_TRANSFORM}
          fill="url(#hill90-light-grad)"
        />
        {/* Left peak (middle layer, shorter) — right edge follows gap boundary */}
        <path
          className="hill-left"
          d={HILL_LEFT}
          transform={HILL_TRACE_TRANSFORM}
          fill="url(#hill90-light-grad)"
        />
        {/* Front hill (foreground, darker) — smooth concave curve */}
        <path
          className="hill-front"
          d={HILL_FRONT}
          transform={HILL_TRACE_TRANSFORM}
          fill="url(#hill90-front-grad)"
        />
      </g>
    </svg>
  );
}
