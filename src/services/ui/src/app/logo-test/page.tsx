'use client';

import { useState, useEffect } from 'react';

/* ------------------------------------------------------------------ */
/*  Base SVG — each animation variant renders this with different CSS  */
/* ------------------------------------------------------------------ */
function Hill({
  className = '',
  id,
  lightColor = '#657278',
  darkColor = '#3B4851',
}: {
  className?: string;
  id?: string;
  lightColor?: string;
  darkColor?: string;
}) {
  return (
    <svg
      id={id}
      viewBox="0 0 660 297"
      xmlns="http://www.w3.org/2000/svg"
      width={200}
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
        d="M 200,297 C 240,220 310,30 365,8 C 420,0 540,120 660,297 Z"
        fill="none"
        stroke="#657278"
        strokeWidth="3"
      />
      <path
        className="draw-left"
        d="M 0,297 C 40,220 150,100 198,88 C 240,78 340,170 430,297 Z"
        fill="none"
        stroke="#657278"
        strokeWidth="3"
      />
      <path
        className="draw-front"
        d="M 240,297 C 310,250 390,110 465,105 C 540,100 610,190 660,297 Z"
        fill="none"
        stroke="#3B4851"
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
        <p className="text-mountain-400 mb-8">
          Pick a number. Hit Replay to see it again.
        </p>

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
          animation: staggerRise 0.7s ease-out 0s both;
          transform-origin: bottom center;
        }
        .anim-stagger .hill-left {
          animation: staggerRise 0.7s ease-out 0.2s both;
          transform-origin: bottom center;
        }
        .anim-stagger .hill-front {
          animation: staggerRise 0.7s ease-out 0.4s both;
          transform-origin: bottom center;
        }
        @keyframes staggerRise {
          from { opacity: 0; transform: translateY(40px) scaleY(0.3); }
          to { opacity: 1; transform: translateY(0) scaleY(1); }
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
          animation: slideFromRight 1s ease-out 0s both;
        }
        .anim-parallax .hill-left {
          animation: slideFromLeft 1s ease-out 0.15s both;
        }
        .anim-parallax .hill-front {
          animation: slideFromRight 0.8s ease-out 0.3s both;
        }
        @keyframes slideFromLeft {
          from { opacity: 0; transform: translateX(-60px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideFromRight {
          from { opacity: 0; transform: translateX(60px); }
          to { opacity: 1; transform: translateX(0); }
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
