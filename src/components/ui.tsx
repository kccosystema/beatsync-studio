"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";

const P: Record<string, ReactNode> = {
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  save: <><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" /><path d="M7 3v5h8V3" /><rect x="7" y="13" width="10" height="6" rx="1" /></>,
  export: <><path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  x: <><path d="M6 6l12 12" /><path d="M18 6 6 18" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" /><path d="M9 7V4h6v3" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></>,
  sparkles: <><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></>,
  transition: <><rect x="3" y="6" width="9" height="12" rx="1.5" /><rect x="12" y="6" width="9" height="12" rx="1.5" opacity=".5" /><path d="M10 12h4" /></>,
  wand: <><path d="m15 4 5 5L9 20l-5-5z" /><path d="M14 5l5 5" /><path d="M5 3v3M3.5 4.5h3M19 15v3M17.5 16.5h3" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 5v6h-6" /></>,
  fullscreen: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
  magnet: <><path d="M6 3v8a6 6 0 0 0 12 0V3" /><path d="M6 7h4M14 7h4" /></>,
  zoomIn: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M11 8v6M8 11h6" /></>,
  zoomOut: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></>,
  sliders: <><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17h0" /></>,
  skipBack: <><path d="M6 5v14" /><path d="M19 5 9 12l10 7z" fill="currentColor" /></>,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
  upload: <><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 20h16" /></>,
  volume: <><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6" /></>,
  scissors: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M8.1 8.1 20 20M8.1 15.9 20 4" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />,
  mute: <><path d="M4 9v6h4l5 4V5L8 9z" /><path d="m17 9 4 6M21 9l-4 6" /></>,
};

export function Icon({ name, size = 16, className = "" }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      {P[name]}
    </svg>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "soft" | "danger"; size?: "sm" | "md" };
export function Button({ variant = "soft", size = "md", className = "", ...rest }: BtnProps) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all select-none disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-violet";
  const sz = size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm";
  const v = {
    primary: "bs-grad text-white shadow-[0_6px_24px_-8px_rgba(139,92,246,0.7)] hover:brightness-110 active:scale-[0.98]",
    ghost: "text-ink-200 hover:bg-ink-750 hover:text-white",
    soft: "bg-ink-750 text-ink-100 hover:bg-ink-700 border border-ink-700",
    danger: "bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20",
  }[variant];
  return <button {...rest} className={`${base} ${sz} ${v} ${className}`} />;
}

export function IconButton({ icon, label, active, className = "", size = 16, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; size?: number }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none ${active ? "bg-violet/20 text-violet-soft" : "text-ink-300 hover:bg-ink-750 hover:text-white"} ${className}`}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Slider({
  label, value, min = 0, max = 100, step = 1, onChange, format, hint,
}: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; hint?: string }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="block" title={hint}>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="text-ink-300">{label}</span>
        <span className="font-mono text-ink-100 tabular-nums">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" className="bs-range" min={min} max={max} step={step} value={value}
        style={{ ["--fill" as string]: `${fill}%` }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Segmented<T extends string | number>({
  value, options, onChange, size = "md",
}: { value: T; options: { value: T; label: string; title?: string }[]; onChange: (v: T) => void; size?: "sm" | "md" }) {
  return (
    <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md ${size === "sm" ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-xs"} font-medium transition-colors ${o.value === value ? "bg-ink-700 text-white shadow" : "text-ink-300 hover:text-white"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">{children}</h3>
      {right}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-ink-200">
      <span>{label}</span>
      <button
        role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-violet" : "bg-ink-600"}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

export function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-ink-700 ${className}`}>
      <div className="bs-grad h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
