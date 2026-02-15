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
      {/* Right peak (background, taller) — left edge follows gap boundary */}
      <path
        className="hill-right"
        d={HILL_RIGHT}
        fill={lightColor}
      />
      {/* Left peak (middle layer, shorter) — right edge follows gap boundary */}
      <path
        className="hill-left"
        d={HILL_LEFT}
        fill={lightColor}
      />
      {/* Front hill (foreground, darker) — smooth concave curve */}
      <path
        className="hill-front"
        d={HILL_FRONT}
        fill={darkColor}
      />
    </svg>
  );
}
