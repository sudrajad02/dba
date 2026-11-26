import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}

const VIEWPORT_PADDING = 8;

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onClose,
  className = "w-56",
  children,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: x,
    top: y,
    ready: false,
  });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Vertical: auto-flip upward if overflowing bottom edge
    let top = y;
    if (y + rect.height > vh - VIEWPORT_PADDING) {
      const flippedTop = y - rect.height;
      if (flippedTop >= VIEWPORT_PADDING) {
        top = flippedTop;
      } else {
        top = Math.max(VIEWPORT_PADDING, vh - rect.height - VIEWPORT_PADDING);
      }
    } else if (top < VIEWPORT_PADDING) {
      top = VIEWPORT_PADDING;
    }

    // Horizontal: auto-flip left if overflowing right edge
    let left = x;
    if (x + rect.width > vw - VIEWPORT_PADDING) {
      left = x - rect.width;
    }
    left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - rect.width - VIEWPORT_PADDING));

    setPos({ left, top, ready: true });
  }, [x, y, children]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const onResize = () => onClose();

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? "visible" : "hidden",
      }}
      onContextMenu={(e) => e.preventDefault()}
      className={`fixed z-50 py-1 rounded-lg shadow-2xl border border-[var(--border-strong)] bg-[var(--surface-panel)] text-zinc-800 dark:text-zinc-100 text-xs max-h-[calc(100vh-16px)] overflow-y-auto select-none ${className}`}
    >
      {children}
    </div>,
    document.body
  );
};
