import React from "react";
import type { DbEngine } from "../types/dba";

interface EngineIconProps {
  engine: DbEngine;
  connected?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_CLS = {
  sm: "w-4 h-4 text-[0.58rem]",
  md: "w-5 h-5 text-[0.65rem]",
  lg: "w-10 h-10 text-sm",
};

const ACTIVE_STYLE: Record<DbEngine, string> = {
  postgres: "bg-sky-500/20 text-sky-400 border-sky-500/40",
  mysql: "bg-teal-500/20 text-teal-400 border-teal-500/40",
  mssql: "bg-red-500/20 text-red-400 border-red-500/40",
  mongodb: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
};

const INACTIVE_STYLE =
  "bg-zinc-500/10 text-zinc-500 dark:text-zinc-500 border-zinc-400/25 dark:border-zinc-700/60";

export const EngineIcon: React.FC<EngineIconProps> = ({
  engine,
  connected = true,
  size = "sm",
  className = "",
}) => {
  const palette = connected ? ACTIVE_STYLE[engine] : INACTIVE_STYLE;
  const sz = SIZE_CLS[size];

  // Crisp inline SVG glyphs inspired by each database engine
  const renderGlyph = () => {
    switch (engine) {
      case "postgres":
        return (
          <svg viewBox="0 0 16 16" className="w-[70%] h-[70%]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="8" cy="4.2" rx="4.8" ry="2.2" />
            <path d="M3.2 4.2v4.3c0 1.2 2.15 2.2 4.8 2.2s4.8-1 4.8-2.2V4.2" />
            <path d="M3.2 8.5v3.2c0 1.2 2.15 2.2 4.8 2.2s4.8-1 4.8-2.2V8.5" />
          </svg>
        );
      case "mysql":
        return (
          <svg viewBox="0 0 16 16" className="w-[72%] h-[72%]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 11.5c1.2-4.2 4.2-7 8.5-7 1.3 0 2.3.5 2.5 1.2-.8.3-1.4.8-1.7 1.6 1 .5 1.5 1.3 1.5 2.4" />
            <path d="M4.5 11.5c1.8-1.8 4-2.2 6.5-1.5" />
            <circle cx="10.2" cy="6.6" r="0.6" fill="currentColor" stroke="none" />
          </svg>
        );
      case "mssql":
        return (
          <svg viewBox="0 0 16 16" className="w-[70%] h-[70%]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="0.8" />
            <rect x="9" y="2.5" width="4.5" height="4.5" rx="0.8" />
            <rect x="2.5" y="9" width="4.5" height="4.5" rx="0.8" />
            <rect x="9" y="9" width="4.5" height="4.5" rx="0.8" />
          </svg>
        );
      case "mongodb":
        return (
          <svg viewBox="0 0 16 16" className="w-[70%] h-[70%]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2c2.8 2.2 4 4.8 4 7.2 0 2.4-1.6 4-4 4.8-2.4-.8-4-2.4-4-4.8C4 6.8 5.2 4.2 8 2z" />
            <path d="M8 6.5v7.5" />
          </svg>
        );
    }
  };

  return (
    <span
      title={`${engine.toUpperCase()} (${connected ? "Connected" : "Disconnected"})`}
      className={`inline-flex items-center justify-center rounded border shrink-0 transition-colors ${sz} ${palette} ${className}`}
    >
      {renderGlyph()}
    </span>
  );
};
