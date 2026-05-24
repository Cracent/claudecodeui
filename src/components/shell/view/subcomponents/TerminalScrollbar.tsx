import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';

type TerminalScrollbarProps = {
  terminalRef: MutableRefObject<Terminal | null>;
  isReady: boolean;
};

export default function TerminalScrollbar({ terminalRef, isReady }: TerminalScrollbarProps) {
  const [thumbPct, setThumbPct] = useState(0);
  const [scrollPct, setScrollPct] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const totalLinesRef = useRef(0);
  const viewportRowsRef = useRef(0);

  // Poll terminal buffer via RAF to track scroll position.
  // Avoids event-ordering edge cases with xterm's onScroll during rapid output.
  useEffect(() => {
    const term = terminalRef.current;
    if (!term || !isReady) return;

    let rafId: number;
    // Track last-seen values to avoid setState on every frame
    let prevViewportY = -1;
    let prevTotal = -1;
    let prevRows = -1;

    const poll = () => {
      const buf = term.buffer.active;
      const currentViewportY = buf.viewportY;
      const currentTotal = buf.length;
      const currentRows = term.rows;

      if (currentViewportY !== prevViewportY || currentTotal !== prevTotal || currentRows !== prevRows) {
        prevViewportY = currentViewportY;
        prevTotal = currentTotal;
        prevRows = currentRows;
        totalLinesRef.current = currentTotal;
        viewportRowsRef.current = currentRows;
        const maxScroll = currentTotal - currentRows;
        setThumbPct(maxScroll > 0 ? Math.max(currentRows / currentTotal, 0.05) : 0);
        setScrollPct(maxScroll > 0 ? currentViewportY / maxScroll : 0);
      }

      rafId = requestAnimationFrame(poll);
    };

    rafId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(rafId);
  }, [terminalRef, isReady]);

  const applyScroll = useCallback((clientY: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const maxScroll = totalLinesRef.current - viewportRowsRef.current;
    if (maxScroll <= 0) return;
    terminalRef.current?.scrollToLine(Math.round(pct * maxScroll));
    setScrollPct(pct);
  }, [terminalRef]);

  const handleTouchStart = (e: React.TouchEvent) => {
    e.stopPropagation();
    draggingRef.current = true;
    if (e.touches.length > 0) applyScroll(e.touches[0].clientY);
  };

  // Document-level listeners so drag continues even if finger drifts outside track
  useEffect(() => {
    const onMove = (e: TouchEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      if (e.touches.length > 0) applyScroll(e.touches[0].clientY);
    };
    const onEnd = () => { draggingRef.current = false; };

    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    document.addEventListener('touchcancel', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [applyScroll]);

  // Use absolute positioning for thumb — CSS percentage margin-top is computed
  // against the containing block's WIDTH, not height. Since the track is only
  // 8px wide, margin-top:80% = 6.4px, making the thumb appear stuck at top.
  // top: X% on an absolutely positioned child IS computed against height.
  return (
    <div
      ref={trackRef}
      className="relative flex-shrink-0 w-2 h-full bg-gray-800/60 rounded select-none md:hidden"
      onTouchStart={handleTouchStart}
    >
      <div
        className="absolute left-0 w-full bg-gray-400/70 rounded-sm"
        style={{
          height: `${thumbPct * 100}%`,
          top: `${scrollPct * (1 - thumbPct) * 100}%`,
          minHeight: thumbPct > 0 ? 20 : 0,
        }}
      />
    </div>
  );
}
