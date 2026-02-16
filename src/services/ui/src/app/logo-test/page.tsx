'use client';

import { useState, useEffect } from 'react';
import Image from 'next/image';
import { HILL_RIGHT, HILL_LEFT, HILL_FRONT, HILL_TRACE_TRANSFORM } from '../../components/hill-paths';

/* ------------------------------------------------------------------ */
/*  Base SVG — each animation variant renders this with different CSS  */
/* ------------------------------------------------------------------ */
function Hill({
  className = '',
  id,
  width = 200,
  height,
  lightColor = '#60757D',
  darkColor = '#3C4A52',
}: {
  className?: string;
  id?: string;
  width?: number;
  height?: number;
  lightColor?: string;
  darkColor?: string;
}) {
  return (
    <svg
      id={id}
      viewBox="0 0 660 297"
      xmlns="http://www.w3.org/2000/svg"
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="Hill90 logo"
    >
      <defs>
        <linearGradient id={`${id || 'hill'}-light-grad`} x1="0" y1="0" x2="660" y2="297" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#7A8E96" />
          <stop offset="100%" stopColor={lightColor} />
        </linearGradient>
        <linearGradient id={`${id || 'hill'}-front-grad`} x1="240" y1="110" x2="660" y2="297" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4C5A63" />
          <stop offset="100%" stopColor={darkColor} />
        </linearGradient>
        <clipPath id={`${id || 'hill'}-corner-clip`} clipPathUnits="userSpaceOnUse">
          <path d="M0 0 H660 V287 Q660 297 650 297 H10 Q0 297 0 287 Z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id || 'hill'}-corner-clip)`}>
        {/* Right peak (background, taller) — left edge follows gap boundary */}
        <path
          className="hill-right"
          d={HILL_RIGHT}
          transform={HILL_TRACE_TRANSFORM}
          fill={`url(#${id || 'hill'}-light-grad)`}
        />
        {/* Left peak (middle layer, shorter) — right edge follows gap boundary */}
        <path
          className="hill-left"
          d={HILL_LEFT}
          transform={HILL_TRACE_TRANSFORM}
          fill={`url(#${id || 'hill'}-light-grad)`}
        />
        {/* Front hill (foreground, darker) — smooth concave curve */}
        <path
          className="hill-front"
          d={HILL_FRONT}
          transform={HILL_TRACE_TRANSFORM}
          fill={`url(#${id || 'hill'}-front-grad)`}
        />
      </g>
    </svg>
  );
}

/* Outlined version for draw-on animation */
function HillOutline({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 660 297"
      xmlns="http://www.w3.org/2000/svg"
      width={200}
      className={className}
      role="img"
      aria-label="Hill90 logo"
    >
      <path
        className="draw-right"
        d={HILL_RIGHT}
        transform={HILL_TRACE_TRANSFORM}
        fill="none"
        stroke="#60757D"
        strokeWidth="3"
      />
      <path
        className="draw-left"
        d={HILL_LEFT}
        transform={HILL_TRACE_TRANSFORM}
        fill="none"
        stroke="#60757D"
        strokeWidth="3"
      />
      <path
        className="draw-front"
        d={HILL_FRONT}
        transform={HILL_TRACE_TRANSFORM}
        fill="none"
        stroke="#3C4A52"
        strokeWidth="3"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Animation card wrapper                                             */
/* ------------------------------------------------------------------ */
function Card({
  number,
  title,
  description,
  children,
  onReplay,
}: {
  number: number;
  title: string;
  description: string;
  children: React.ReactNode;
  onReplay: () => void;
}) {
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 flex flex-col items-center gap-4">
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-brand-400">{number}</span>
          <div>
            <h3 className="font-semibold text-white">{title}</h3>
            <p className="text-xs text-mountain-400">{description}</p>
          </div>
        </div>
        <button
          onClick={onReplay}
          className="px-3 py-1 text-xs rounded bg-navy-700 hover:bg-navy-600 text-mountain-300 transition-colors cursor-pointer"
        >
          Replay
        </button>
      </div>
      <div className="h-32 flex items-center justify-center">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */
export default function LogoTestPage() {
  const [keys, setKeys] = useState<Record<number, number>>({});

  const replay = (n: number) => {
    setKeys((prev) => ({ ...prev, [n]: (prev[n] ?? 0) + 1 }));
  };

  // Auto-play all on mount
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="min-h-screen bg-navy-900 text-white p-8">
      <div className="max-w-5xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Logo Animation Picker</h1>
        <p className="text-mountain-400 mb-4">
          Pick a number. Hit Replay to see it again.
        </p>

        {/* Side-by-side comparison */}
        <div className="rounded-lg border border-navy-700 bg-navy-800 p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">PNG vs SVG Comparison</h2>
          <div className="grid grid-cols-2 gap-8">
            <div className="flex flex-col items-center gap-2">
              <span className="text-xs text-mountain-400 font-mono">Original PNG</span>
              <div className="w-[300px] h-[135px] flex items-center justify-center">
                <Image src="/Hill90-logo10-notext.png" alt="PNG original" width={300} height={135} />
              </div>
            </div>
            <div className="flex flex-col items-center gap-2">
              <span className="text-xs text-mountain-400 font-mono">SVG Code</span>
              <div className="w-[300px] h-[135px] flex items-center justify-center">
                <Hill id="compare-svg" width={300} height={135} />
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {/* 1 — Fade In */}
          <Card number={1} title="Fade In" description="Simple opacity fade" onReplay={() => replay(1)}>
            {mounted && <Hill key={keys[1]} className="anim-fade-in" />}
          </Card>

          {/* 2 — Slide Up */}
          <Card number={2} title="Slide Up" description="Rise from below + fade" onReplay={() => replay(2)}>
            {mounted && <Hill key={keys[2]} className="anim-slide-up" />}
          </Card>

          {/* 3 — Draw On */}
          <Card number={3} title="Draw On" description="Outline draws itself" onReplay={() => replay(3)}>
            {mounted && <HillOutline key={keys[3]} className="anim-draw-on" />}
          </Card>

          {/* 4 — Staggered Rise */}
          <Card number={4} title="Staggered Rise" description="Each hill rises with delay" onReplay={() => replay(4)}>
            {mounted && <Hill key={keys[4]} className="anim-stagger" />}
          </Card>

          {/* 5 — Scale Bounce */}
          <Card number={5} title="Scale Bounce" description="Spring-like pop in" onReplay={() => replay(5)}>
            {mounted && <Hill key={keys[5]} className="anim-bounce" />}
          </Card>

          {/* 6 — Parallax Slide */}
          <Card number={6} title="Parallax Slide" description="Hills arrive from different sides" onReplay={() => replay(6)}>
            {mounted && <Hill key={keys[6]} className="anim-parallax" />}
          </Card>

          {/* 7 — Gentle Breathe */}
          <Card number={7} title="Gentle Breathe" description="Continuous subtle pulse (loop)" onReplay={() => replay(7)}>
            {mounted && <Hill key={keys[7]} className="anim-breathe" />}
          </Card>

          {/* 8 — Draw + Fill */}
          <Card number={8} title="Draw + Fill" description="Outline draws, then fills in" onReplay={() => replay(8)}>
            {mounted && <DrawFill key={keys[8]} />}
          </Card>

          {/* 9 — Flash In */}
          <Card number={9} title="Flash In" description="Quick bright reveal" onReplay={() => replay(9)}>
            {mounted && <Hill key={keys[9]} className="anim-flash-in" />}
          </Card>

          {/* 10 — Rotate In */}
          <Card number={10} title="Rotate In" description="Slight rotate + settle" onReplay={() => replay(10)}>
            {mounted && <Hill key={keys[10]} className="anim-rotate-in" />}
          </Card>

          {/* 11 — Soft Focus */}
          <Card number={11} title="Soft Focus" description="Blur to sharp" onReplay={() => replay(11)}>
            {mounted && <Hill key={keys[11]} className="anim-soft-focus" />}
          </Card>

          {/* 12 — Color Shift */}
          <Card number={12} title="Color Shift" description="Cool-to-neutral tint" onReplay={() => replay(12)}>
            {mounted && <Hill key={keys[12]} className="anim-color-shift" />}
          </Card>

          {/* 13 — Shimmer */}
          <Card number={13} title="Shimmer" description="Subtle highlight pulse" onReplay={() => replay(13)}>
            {mounted && <Hill key={keys[13]} className="anim-shimmer" />}
          </Card>

          {/* 14 — Pop Fade */}
          <Card number={14} title="Pop Fade" description="Pop from near-zero" onReplay={() => replay(14)}>
            {mounted && <Hill key={keys[14]} className="anim-pop-fade" />}
          </Card>

          {/* 15 — Drift Up */}
          <Card number={15} title="Drift Up" description="Slow lift into place" onReplay={() => replay(15)}>
            {mounted && <Hill key={keys[15]} className="anim-drift-up" />}
          </Card>

          {/* 16 — Blur Lift */}
          <Card number={16} title="Blur Lift" description="Blur + fade + rise" onReplay={() => replay(16)}>
            {mounted && <Hill key={keys[16]} className="anim-blur-lift" />}
          </Card>

          {/* 17 — Glow Hold */}
          <Card number={17} title="Glow Hold" description="Glow pulse then settle" onReplay={() => replay(17)}>
            {mounted && <Hill key={keys[17]} className="anim-glow-hold" />}
          </Card>

          {/* 18 — Cascade Fade */}
          <Card number={18} title="Cascade Fade" description="Paths fade in sequence" onReplay={() => replay(18)}>
            {mounted && <Hill key={keys[18]} className="anim-cascade-fade" />}
          </Card>

          {/* 19 — Wobble In */}
          <Card number={19} title="Wobble In" description="Gentle settle wobble" onReplay={() => replay(19)}>
            {mounted && <Hill key={keys[19]} className="anim-wobble-in" />}
          </Card>

          {/* 20 — Zoom Out In */}
          <Card number={20} title="Zoom Out In" description="Starts large then lands" onReplay={() => replay(20)}>
            {mounted && <Hill key={keys[20]} className="anim-zoom-out-in" />}
          </Card>
        </div>
      </div>

      <style>{`
        /* 1 — Fade In */
        .anim-fade-in {
          animation: fadeIn 1.2s ease-out both;
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        /* 2 — Slide Up */
        .anim-slide-up {
          animation: slideUp 0.8s ease-out both;
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(30px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* 3 — Draw On (stroke-dasharray) */
        .anim-draw-on .draw-right,
        .anim-draw-on .draw-left,
        .anim-draw-on .draw-front {
          stroke-dasharray: 2000;
          stroke-dashoffset: 2000;
        }
        .anim-draw-on .draw-right {
          animation: drawStroke 1.5s ease-out 0s forwards;
        }
        .anim-draw-on .draw-left {
          animation: drawStroke 1.5s ease-out 0.3s forwards;
        }
        .anim-draw-on .draw-front {
          animation: drawStroke 1.5s ease-out 0.6s forwards;
        }
        @keyframes drawStroke {
          to { stroke-dashoffset: 0; }
        }

        /* 4 — Staggered Rise */
        .anim-stagger .hill-right {
          animation: staggerFade 0.6s ease-out 0s both;
        }
        .anim-stagger .hill-left {
          animation: staggerFade 0.6s ease-out 0.18s both;
        }
        .anim-stagger .hill-front {
          animation: staggerFade 0.6s ease-out 0.36s both;
        }
        @keyframes staggerFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        /* 5 — Scale Bounce */
        .anim-bounce {
          animation: scaleBounce 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) both;
          transform-origin: center bottom;
        }
        @keyframes scaleBounce {
          from { opacity: 0; transform: scale(0.3); }
          to { opacity: 1; transform: scale(1); }
        }

        /* 6 — Parallax Slide */
        .anim-parallax .hill-right {
          animation: pathWipe 0.9s ease-out 0s both;
        }
        .anim-parallax .hill-left {
          animation: pathWipe 0.9s ease-out 0.15s both;
        }
        .anim-parallax .hill-front {
          animation: pathWipe 0.8s ease-out 0.3s both;
        }
        @keyframes pathWipe {
          from { opacity: 0; clip-path: inset(0 100% 0 0); }
          to { opacity: 1; clip-path: inset(0 0 0 0); }
        }

        /* 7 — Gentle Breathe (loops) */
        .anim-breathe {
          animation: breathe 3s ease-in-out infinite;
        }
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }

        /* 8 — Draw + Fill (handled in component) */
        .draw-fill-outline .draw-right,
        .draw-fill-outline .draw-left,
        .draw-fill-outline .draw-front {
          stroke-dasharray: 2000;
          stroke-dashoffset: 2000;
        }
        .draw-fill-outline .draw-right {
          animation: drawStroke 1s ease-out 0s forwards;
        }
        .draw-fill-outline .draw-left {
          animation: drawStroke 1s ease-out 0.2s forwards;
        }
        .draw-fill-outline .draw-front {
          animation: drawStroke 1s ease-out 0.4s forwards;
        }
        .draw-fill-solid {
          animation: fadeIn 0.6s ease-out 1.2s both;
        }

        /* 9 — Flash In */
        .anim-flash-in {
          animation: flashIn 0.7s ease-out both;
        }
        @keyframes flashIn {
          0% { opacity: 0; filter: brightness(2.5); }
          35% { opacity: 1; filter: brightness(1.6); }
          100% { opacity: 1; filter: brightness(1); }
        }

        /* 10 — Rotate In */
        .anim-rotate-in {
          animation: rotateIn 0.9s cubic-bezier(0.2, 0.9, 0.2, 1) both;
          transform-origin: center;
        }
        @keyframes rotateIn {
          from { opacity: 0; transform: rotate(-8deg) scale(0.9); }
          to { opacity: 1; transform: rotate(0deg) scale(1); }
        }

        /* 11 — Soft Focus */
        .anim-soft-focus {
          animation: softFocus 0.9s ease-out both;
        }
        @keyframes softFocus {
          from { opacity: 0.4; filter: blur(8px); }
          to { opacity: 1; filter: blur(0px); }
        }

        /* 12 — Color Shift */
        .anim-color-shift {
          animation: colorShift 1.2s ease-out both;
        }
        @keyframes colorShift {
          from { filter: hue-rotate(20deg) saturate(1.25); }
          to { filter: hue-rotate(0deg) saturate(1); }
        }

        /* 13 — Shimmer */
        .anim-shimmer {
          animation: shimmer 1.4s ease-in-out both;
        }
        @keyframes shimmer {
          0% { filter: brightness(0.9) contrast(0.95); }
          50% { filter: brightness(1.12) contrast(1.05); }
          100% { filter: brightness(1) contrast(1); }
        }

        /* 14 — Pop Fade */
        .anim-pop-fade {
          animation: popFade 0.75s cubic-bezier(0.34, 1.56, 0.64, 1) both;
          transform-origin: center bottom;
        }
        @keyframes popFade {
          from { opacity: 0; transform: scale(0.78); }
          to { opacity: 1; transform: scale(1); }
        }

        /* 15 — Drift Up */
        .anim-drift-up {
          animation: driftUp 1s ease-out both;
        }
        @keyframes driftUp {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }

        /* 16 — Blur Lift */
        .anim-blur-lift {
          animation: blurLift 0.9s ease-out both;
        }
        @keyframes blurLift {
          from { opacity: 0; transform: translateY(16px); filter: blur(7px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0px); }
        }

        /* 17 — Glow Hold */
        .anim-glow-hold {
          animation: glowHold 1.2s ease-out both;
        }
        @keyframes glowHold {
          0% { filter: drop-shadow(0 0 0 rgba(154, 186, 201, 0)); }
          40% { filter: drop-shadow(0 0 14px rgba(154, 186, 201, 0.55)); }
          100% { filter: drop-shadow(0 0 0 rgba(154, 186, 201, 0)); }
        }

        /* 18 — Cascade Fade */
        .anim-cascade-fade .hill-right {
          animation: cascadeFade 0.55s ease-out 0s both;
        }
        .anim-cascade-fade .hill-left {
          animation: cascadeFade 0.55s ease-out 0.18s both;
        }
        .anim-cascade-fade .hill-front {
          animation: cascadeFade 0.55s ease-out 0.36s both;
        }
        @keyframes cascadeFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        /* 19 — Wobble In */
        .anim-wobble-in {
          animation: wobbleIn 0.95s ease-out both;
          transform-origin: center bottom;
        }
        @keyframes wobbleIn {
          0% { opacity: 0; transform: rotate(-3deg) scale(0.94); }
          45% { opacity: 1; transform: rotate(2deg) scale(1.02); }
          70% { transform: rotate(-1deg) scale(0.995); }
          100% { transform: rotate(0deg) scale(1); }
        }

        /* 20 — Zoom Out In */
        .anim-zoom-out-in {
          animation: zoomOutIn 0.85s ease-out both;
          transform-origin: center;
        }
        @keyframes zoomOutIn {
          from { opacity: 0; transform: scale(1.12); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

/* #8 — Draw + Fill composite: outline draws, then solid fades in on top */
function DrawFill() {
  return (
    <div className="relative">
      <HillOutline className="draw-fill-outline" />
      <div className="absolute inset-0">
        <Hill className="draw-fill-solid" />
      </div>
    </div>
  );
}
