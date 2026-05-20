'use client';

import { type RefObject, useEffect, useState } from 'react';

export type PopupAnchor = { top: number; right: number };

// Measures the trigger button's bounding box so a portal-rendered popup
// can position itself with `position: fixed` directly under it. Updates
// on viewport resize so the popup tracks the icon if the layout shifts.
export function usePopupAnchor(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
): PopupAnchor | null {
  const [pos, setPos] = useState<PopupAnchor | null>(null);

  useEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    function measure() {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setPos({
        top: r.bottom + 8,
        right: Math.max(8, window.innerWidth - r.right),
      });
    }
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, ref]);

  return pos;
}
