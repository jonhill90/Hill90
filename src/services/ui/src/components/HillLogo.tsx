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
      {/* Right peak (background, taller) — straight slopes, slight convex right edge */}
      <path
        className="hill-right"
        d="M 55,297 L 340,18 Q 365,-2 390,18 Q 530,130 660,297 Z"
        fill={lightColor}
      />
      {/* Left peak (middle layer, shorter) — angular triangle, rounded peak */}
      <path
        className="hill-left"
        d="M 0,297 L 180,100 Q 198,78 220,95 L 422,297 Z"
        fill={lightColor}
      />
      {/* Front hill (foreground, darker) — smooth concave curve */}
      <path
        className="hill-front"
        d="M 240,297 C 340,200 430,110 465,105 C 510,100 600,200 660,297 Z"
        fill={darkColor}
      />
    </svg>
  );
}
