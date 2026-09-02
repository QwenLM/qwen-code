import { useEffect, useRef } from 'react';
import { useTheme, WebShellThemeId } from '../themeContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import styles from './NewSessionDotField.module.css';

interface Dot {
  anchorX: number;
  anchorY: number;
  x: number;
  y: number;
}

export function NewSessionDotField() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const theme = useTheme();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d', { alpha: true });
    if (!root || !canvas || !context) return undefined;

    const dots: Dot[] = [];
    const pointer = {
      x: -9999,
      y: -9999,
      previousX: -9999,
      previousY: -9999,
      speed: 0,
    };
    let width = 0;
    let height = 0;
    let engagement = 0;
    let glowOpacity = 0;
    let frameId = 0;
    let running = false;
    let needsRepaint = true;
    let speedTimer: number | undefined;

    const buildDots = () => {
      dots.length = 0;
      const step = 15;
      const columns = Math.floor(width / step);
      const rows = Math.floor(height / step);
      const paddingX = (width % step) / 2;
      const paddingY = (height % step) / 2;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const anchorX = paddingX + column * step + step / 2;
          const anchorY = paddingY + row * step + step / 2;
          dots.push({
            anchorX,
            anchorY,
            x: anchorX,
            y: anchorY,
          });
        }
      }
    };

    const draw = () => {
      const targetEngagement = Math.min(pointer.speed / 5, 1);
      engagement += (targetEngagement - engagement) * 0.06;
      if (engagement < 0.001) engagement = 0;
      glowOpacity += (engagement - glowOpacity) * 0.08;

      let settled = engagement === 0 && glowOpacity < 0.001;
      if (settled) {
        for (const dot of dots) {
          if (
            Math.abs(dot.x - dot.anchorX) > 0.01 ||
            Math.abs(dot.y - dot.anchorY) > 0.01
          ) {
            settled = false;
            break;
          }
        }
      }

      if (settled && !needsRepaint) {
        running = false;
        frameId = 0;
        return;
      }

      context.clearRect(0, 0, width, height);
      context.fillStyle =
        theme === WebShellThemeId.Light
          ? 'rgba(172, 191, 255, 0.85)'
          : 'rgba(172, 191, 255, 0.42)';
      context.beginPath();

      const cursorRadiusSquared = 500 * 500;
      for (const dot of dots) {
        const dx = pointer.x - dot.anchorX;
        const dy = pointer.y - dot.anchorY;
        const distanceSquared = dx * dx + dy * dy;
        if (
          !reducedMotion &&
          distanceSquared < cursorRadiusSquared &&
          engagement > 0.01
        ) {
          const distance = Math.sqrt(distanceSquared);
          const amount = 1 - distance / 500;
          const push = amount * amount * 67 * engagement;
          const direction = Math.atan2(dy, dx);
          dot.x += (dot.anchorX - Math.cos(direction) * push - dot.x) * 0.15;
          dot.y += (dot.anchorY - Math.sin(direction) * push - dot.y) * 0.15;
        } else {
          dot.x += (dot.anchorX - dot.x) * 0.1;
          dot.y += (dot.anchorY - dot.y) * 0.1;
        }
        context.moveTo(dot.x + 0.5, dot.y);
        context.arc(dot.x, dot.y, 0.5, 0, Math.PI * 2);
      }
      context.fill();

      if (!reducedMotion && glowOpacity > 0.001) {
        const glow = context.createRadialGradient(
          pointer.x,
          pointer.y,
          0,
          pointer.x,
          pointer.y,
          160,
        );
        glow.addColorStop(0, 'rgba(0, 0, 0, 1)');
        glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
        context.globalAlpha = glowOpacity;
        context.globalCompositeOperation = 'destination-out';
        context.fillStyle = glow;
        context.fillRect(pointer.x - 160, pointer.y - 160, 320, 320);
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1;
      }

      needsRepaint = false;
      if (!reducedMotion) frameId = window.requestAnimationFrame(draw);
    };

    const startLoop = () => {
      if (!reducedMotion && !running) {
        running = true;
        frameId = window.requestAnimationFrame(draw);
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = root.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildDots();
      needsRepaint = true;
      if (reducedMotion) draw();
      else startLoop();
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (pointer.previousX === -9999) {
        pointer.previousX = x;
        pointer.previousY = y;
      }
      pointer.x = x;
      pointer.y = y;
      startLoop();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    resize();
    if (!reducedMotion) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      speedTimer = window.setInterval(() => {
        const dx = pointer.previousX - pointer.x;
        const dy = pointer.previousY - pointer.y;
        const distance = Math.hypot(dx, dy);
        pointer.speed += (distance - pointer.speed) * 0.5;
        if (pointer.speed < 0.001) pointer.speed = 0;
        pointer.previousX = pointer.x;
        pointer.previousY = pointer.y;
        if (pointer.speed > 0) startLoop();
      }, 20);
    }

    return () => {
      window.cancelAnimationFrame(frameId);
      if (speedTimer !== undefined) window.clearInterval(speedTimer);
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
    };
  }, [reducedMotion, theme]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      data-web-shell-new-session-dot-field
      aria-hidden="true"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
