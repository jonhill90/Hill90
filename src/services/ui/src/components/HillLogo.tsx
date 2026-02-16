import { HILL_RIGHT, HILL_LEFT, HILL_FRONT } from './hill-paths';

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
      </defs>
      {/* Right peak (background, taller) — left edge follows gap boundary */}
      <path
        className="hill-right"
        d={HILL_RIGHT}
        fill="url(#hill90-light-grad)"
      />
      {/* Left peak (middle layer, shorter) — right edge follows gap boundary */}
      <path
        className="hill-left"
        d={HILL_LEFT}
        fill="url(#hill90-light-grad)"
      />
      {/* Front hill (foreground, darker) — smooth concave curve */}
      <path
        className="hill-front"
        d={HILL_FRONT}
        fill="url(#hill90-front-grad)"
      />
      {/* Subtle shoulder highlight to emulate PNG rim softness */}
      <path
        d="M 240,297 C 330,205 420,118 462,108 C 508,98 598,200 660,297"
        fill="none"
        stroke="#91A2AA"
        strokeOpacity="0.32"
        strokeWidth="2"
      />
    </svg>
  );
}
