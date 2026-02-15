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
        d="M 458,297 L 256,95 C 300,40 340,5 365,5 C 390,5 540,130 660,297 Z"
        fill={lightColor}
      />
      {/* Left peak (middle layer, shorter) — right edge follows gap boundary */}
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
