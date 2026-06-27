import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  PET_BACKGROUND_SIZE,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
  backgroundPositionFor,
  buildSequence,
  type PetState,
} from '@/pets/pet-animation';

interface QwenPetProps {
  /** URL or data URL of the 8x9 sprite atlas. */
  spritesheetUrl: string;
  state?: PetState;
  /** Rendered height in px; width derives from the cell aspect ratio. */
  size?: number;
  className?: string;
  /** Force a single static frame regardless of the OS motion preference. */
  staticFrame?: boolean;
}

/**
 * Renders one animated pet by stepping a sprite atlas via `background-position`.
 * A timeout chain (rather than CSS steps) lets each frame carry its own
 * duration and lets non-idle states settle back into the idle loop.
 */
export function QwenPet({
  spritesheetUrl,
  state = 'idle',
  size = 72,
  className,
  staticFrame,
}: QwenPetProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const prefersReduced = useReducedMotion();
  const reduced = Boolean(staticFrame) || prefersReduced;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { frames, loopStartIndex } = buildSequence(state, reduced);
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    el.style.backgroundPosition = backgroundPositionFor(frames[0]);
    if (frames.length <= 1) return;

    const schedule = () => {
      timer = setTimeout(() => {
        const next = index + 1;
        if (next >= frames.length) {
          if (loopStartIndex != null) {
            index = loopStartIndex;
            el.style.backgroundPosition = backgroundPositionFor(frames[index]);
            schedule();
          } else {
            timer = null;
          }
          return;
        }
        index = next;
        el.style.backgroundPosition = backgroundPositionFor(frames[index]);
        schedule();
      }, frames[index].durationMs);
    };

    schedule();
    return () => {
      if (timer != null) clearTimeout(timer);
    };
  }, [state, reduced, spritesheetUrl]);

  const width = Math.round(size * (PET_CELL_WIDTH / PET_CELL_HEIGHT));

  return (
    <div
      ref={ref}
      aria-hidden
      data-pet-state={state}
      className={cn('shrink-0 select-none bg-no-repeat', className)}
      style={{
        backgroundImage: `url(${spritesheetUrl})`,
        backgroundSize: PET_BACKGROUND_SIZE,
        width: `${width}px`,
        height: `${size}px`,
      }}
    />
  );
}
