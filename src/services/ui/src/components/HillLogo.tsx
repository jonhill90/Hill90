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
  lightColor = '#657278',
  darkColor = '#3B4851',
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
      {/* Right peak (background, taller) */}
      <path
        className="hill-right"
        d="M 200,297 C 240,220 310,30 365,8 C 420,0 540,120 660,297 Z"
        fill={lightColor}
      />
      {/* Left peak (middle layer, shorter) */}
      <path
        className="hill-left"
        d="M 0,297 C 40,220 150,100 198,88 C 240,78 340,170 430,297 Z"
        fill={lightColor}
      />
      {/* Front hill (foreground, darker) */}
      <path
        className="hill-front"
        d="M 240,297 C 310,250 390,110 465,105 C 540,100 610,190 660,297 Z"
        fill={darkColor}
      />
    </svg>
  );
}
