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

          {/* 21 — Neon Sweep */}
          <Card number={21} title="Neon Sweep" description="Glow sweep across hills" onReplay={() => replay(21)}>
            {mounted && <Hill key={keys[21]} className="anim-neon-sweep" />}
          </Card>

          {/* 22 — Shadow Drift */}
          <Card number={22} title="Shadow Drift" description="Depth shift with soft shadow" onReplay={() => replay(22)}>
            {mounted && <Hill key={keys[22]} className="anim-shadow-drift" />}
          </Card>

          {/* 23 — Signal Pulse */}
          <Card number={23} title="Signal Pulse" description="Rhythmic brightness pulse" onReplay={() => replay(23)}>
            {mounted && <Hill key={keys[23]} className="anim-signal-pulse" />}
          </Card>

          {/* 24 — Scanline Reveal */}
          <Card number={24} title="Scanline Reveal" description="Top-down scanline appear" onReplay={() => replay(24)}>
            {mounted && <Hill key={keys[24]} className="anim-scanline-reveal" />}
          </Card>

          {/* 25 — Terminal Boot */}
          <Card number={25} title="Terminal Boot" description="Stepped boot-like reveal" onReplay={() => replay(25)}>
            {mounted && <Hill key={keys[25]} className="anim-terminal-boot" />}
          </Card>

          {/* 26 — Aurora Tint */}
          <Card number={26} title="Aurora Tint" description="Subtle hue glide" onReplay={() => replay(26)}>
            {mounted && <Hill key={keys[26]} className="anim-aurora-tint" />}
          </Card>

          {/* 27 — Luma Pop */}
          <Card number={27} title="Luma Pop" description="Contrast pop then settle" onReplay={() => replay(27)}>
            {mounted && <Hill key={keys[27]} className="anim-luma-pop" />}
          </Card>

          {/* 28 — Beacon */}
          <Card number={28} title="Beacon" description="Soft pulse + glow beacon" onReplay={() => replay(28)}>
            {mounted && <Hill key={keys[28]} className="anim-beacon" />}
          </Card>

          {/* 29 — Boot Sequence */}
          <Card number={29} title="Boot Sequence" description="Terminal-like stepped startup" onReplay={() => replay(29)}>
            {mounted && <Hill key={keys[29]} className="anim-boot-sequence" />}
          </Card>

          {/* 30 — CRT Flicker */}
          <Card number={30} title="CRT Flicker" description="Analog flicker settle-in" onReplay={() => replay(30)}>
            {mounted && <Hill key={keys[30]} className="anim-crt-flicker" />}
          </Card>

          {/* 31 — Data Sweep */}
          <Card number={31} title="Data Sweep" description="Horizontal scan pass reveal" onReplay={() => replay(31)}>
            {mounted && <Hill key={keys[31]} className="anim-data-sweep" />}
          </Card>

          {/* 32 — Glitch Pop */}
          <Card number={32} title="Glitch Pop" description="Brief split-channel glitch" onReplay={() => replay(32)}>
            {mounted && <Hill key={keys[32]} className="anim-glitch-pop" />}
          </Card>

          {/* 33 — Lock-On */}
          <Card number={33} title="Lock-On" description="Zoom lock with sharp settle" onReplay={() => replay(33)}>
            {mounted && <Hill key={keys[33]} className="anim-lock-on" />}
          </Card>

          {/* 34 — Voltage Rise */}
          <Card number={34} title="Voltage Rise" description="Brightness ramp then normalize" onReplay={() => replay(34)}>
            {mounted && <Hill key={keys[34]} className="anim-voltage-rise" />}
          </Card>

          {/* 35 — Ghost Trail */}
          <Card number={35} title="Ghost Trail" description="Afterimage trail fade-out" onReplay={() => replay(35)}>
            {mounted && <Hill key={keys[35]} className="anim-ghost-trail" />}
          </Card>

          {/* 36 — Cold Start */}
          <Card number={36} title="Cold Start" description="Dim boot to full signal" onReplay={() => replay(36)}>
            {mounted && <Hill key={keys[36]} className="anim-cold-start" />}
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

        /* 21 — Neon Sweep */
        .anim-neon-sweep {
          animation: neonSweep 1.2s ease-out both;
        }
        @keyframes neonSweep {
          0% { opacity: 0; filter: brightness(0.8) drop-shadow(0 0 0 rgba(128, 191, 230, 0)); clip-path: inset(0 100% 0 0); }
          55% { opacity: 1; filter: brightness(1.2) drop-shadow(0 0 12px rgba(128, 191, 230, 0.45)); clip-path: inset(0 0 0 0); }
          100% { opacity: 1; filter: brightness(1) drop-shadow(0 0 0 rgba(128, 191, 230, 0)); clip-path: inset(0 0 0 0); }
        }

        /* 22 — Shadow Drift */
        .anim-shadow-drift {
          animation: shadowDrift 1s ease-out both;
        }
        @keyframes shadowDrift {
          from { opacity: 0; transform: translateY(10px); filter: drop-shadow(0 14px 20px rgba(0,0,0,0.35)); }
          to { opacity: 1; transform: translateY(0); filter: drop-shadow(0 6px 8px rgba(0,0,0,0.18)); }
        }

        /* 23 — Signal Pulse */
        .anim-signal-pulse {
          animation: signalPulse 1.3s ease-in-out both;
        }
        @keyframes signalPulse {
          0% { opacity: 0.55; filter: saturate(0.9) brightness(0.9); }
          35% { opacity: 1; filter: saturate(1.15) brightness(1.12); }
          70% { opacity: 0.95; filter: saturate(1.05) brightness(1.02); }
          100% { opacity: 1; filter: saturate(1) brightness(1); }
        }

        /* 24 — Scanline Reveal */
        .anim-scanline-reveal {
          animation: scanlineReveal 0.95s steps(12, end) both;
        }
        @keyframes scanlineReveal {
          from { opacity: 0; clip-path: inset(0 0 100% 0); }
          to { opacity: 1; clip-path: inset(0 0 0 0); }
        }

        /* 25 — Terminal Boot */
        .anim-terminal-boot {
          animation: terminalBoot 1s steps(8, end) both;
        }
        @keyframes terminalBoot {
          0% { opacity: 0; filter: contrast(1.25) brightness(0.8); clip-path: inset(0 100% 0 0); }
          35% { opacity: 0.55; clip-path: inset(0 50% 0 0); }
          65% { opacity: 0.85; clip-path: inset(0 18% 0 0); }
          100% { opacity: 1; filter: contrast(1) brightness(1); clip-path: inset(0 0 0 0); }
        }

        /* 26 — Aurora Tint */
        .anim-aurora-tint {
          animation: auroraTint 1.5s ease-out both;
        }
        @keyframes auroraTint {
          0% { opacity: 0.7; filter: hue-rotate(30deg) saturate(1.2); }
          45% { opacity: 1; filter: hue-rotate(-8deg) saturate(1.15); }
          100% { opacity: 1; filter: hue-rotate(0deg) saturate(1); }
        }

        /* 27 — Luma Pop */
        .anim-luma-pop {
          animation: lumaPop 0.8s cubic-bezier(0.28, 1.2, 0.4, 1) both;
        }
        @keyframes lumaPop {
          from { opacity: 0; filter: contrast(1.35) brightness(1.2); transform: scale(0.96); }
          to { opacity: 1; filter: contrast(1) brightness(1); transform: scale(1); }
        }

        /* 28 — Beacon */
        .anim-beacon {
          animation: beacon 1.4s ease-out both;
        }
        @keyframes beacon {
          0% { opacity: 0; filter: drop-shadow(0 0 0 rgba(180, 218, 242, 0)); transform: scale(0.98); }
          50% { opacity: 1; filter: drop-shadow(0 0 16px rgba(180, 218, 242, 0.55)); transform: scale(1.01); }
          100% { opacity: 1; filter: drop-shadow(0 0 0 rgba(180, 218, 242, 0)); transform: scale(1); }
        }

        /* 29 — Boot Sequence */
        .anim-boot-sequence {
          animation: bootSequence 1.15s steps(10, end) both;
        }
        @keyframes bootSequence {
          0% { opacity: 0; filter: brightness(0.7) contrast(1.2); clip-path: inset(0 100% 0 0); }
          35% { opacity: 0.45; clip-path: inset(0 52% 0 0); }
          70% { opacity: 0.85; clip-path: inset(0 18% 0 0); }
          100% { opacity: 1; filter: brightness(1) contrast(1); clip-path: inset(0 0 0 0); }
        }

        /* 30 — CRT Flicker */
        .anim-crt-flicker {
          animation: crtFlicker 1.1s linear both;
        }
        @keyframes crtFlicker {
          0% { opacity: 0; filter: brightness(0.75) contrast(1.2); }
          18% { opacity: 0.55; filter: brightness(1.12) contrast(1.05); }
          24% { opacity: 0.35; }
          38% { opacity: 0.88; }
          44% { opacity: 0.7; }
          100% { opacity: 1; filter: brightness(1) contrast(1); }
        }

        /* 31 — Data Sweep */
        .anim-data-sweep {
          animation: dataSweep 1.05s ease-out both;
        }
        @keyframes dataSweep {
          0% { opacity: 0; transform: translateX(-14px); clip-path: inset(0 100% 0 0); }
          60% { opacity: 1; transform: translateX(0); clip-path: inset(0 10% 0 0); }
          100% { opacity: 1; clip-path: inset(0 0 0 0); }
        }

        /* 32 — Glitch Pop */
        .anim-glitch-pop {
          animation: glitchPop 0.95s ease-out both;
        }
        @keyframes glitchPop {
          0% { opacity: 0; filter: hue-rotate(20deg) saturate(1.25); transform: translateX(-3px); }
          20% { opacity: 0.85; transform: translateX(3px); }
          30% { transform: translateX(-2px); }
          45% { transform: translateX(1px); }
          100% { opacity: 1; filter: hue-rotate(0deg) saturate(1); transform: translateX(0); }
        }

        /* 33 — Lock-On */
        .anim-lock-on {
          animation: lockOn 0.9s cubic-bezier(0.2, 0.95, 0.2, 1) both;
          transform-origin: center;
        }
        @keyframes lockOn {
          0% { opacity: 0; transform: scale(1.08); filter: blur(2px); }
          55% { opacity: 1; transform: scale(0.995); filter: blur(0.3px); }
          100% { opacity: 1; transform: scale(1); filter: blur(0); }
        }

        /* 34 — Voltage Rise */
        .anim-voltage-rise {
          animation: voltageRise 1.2s ease-out both;
        }
        @keyframes voltageRise {
          0% { opacity: 0.5; filter: brightness(0.78) saturate(0.95); }
          45% { opacity: 1; filter: brightness(1.18) saturate(1.08); }
          75% { filter: brightness(1.04) saturate(1.02); }
          100% { opacity: 1; filter: brightness(1) saturate(1); }
        }

        /* 35 — Ghost Trail */
        .anim-ghost-trail {
          animation: ghostTrail 1.05s ease-out both;
        }
        @keyframes ghostTrail {
          0% { opacity: 0; filter: drop-shadow(8px 0 0 rgba(156, 187, 205, 0.45)); transform: translateX(-8px); }
          55% { opacity: 1; filter: drop-shadow(2px 0 0 rgba(156, 187, 205, 0.2)); transform: translateX(0); }
          100% { opacity: 1; filter: drop-shadow(0 0 0 rgba(156, 187, 205, 0)); }
        }

        /* 36 — Cold Start */
        .anim-cold-start {
          animation: coldStart 1.25s ease-out both;
        }
        @keyframes coldStart {
          0% { opacity: 0; filter: brightness(0.45) saturate(0.7) blur(1.6px); transform: translateY(6px); }
          45% { opacity: 0.85; filter: brightness(0.9) saturate(0.92) blur(0.5px); }
          100% { opacity: 1; filter: brightness(1) saturate(1) blur(0); transform: translateY(0); }
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
