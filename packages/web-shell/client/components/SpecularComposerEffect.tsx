import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useTheme, WebShellThemeId } from '../themeContext';
import { usePrefersReducedMotion } from '../hooks/usePrefersReducedMotion';
import styles from './ChatEditor.module.css';

const VERTEX_SHADER = `#version 300 es
  in vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  uniform vec2 center;
  uniform vec2 halfSize;
  uniform vec3 lineColor;
  uniform float radius;
  uniform float angle;
  uniform float intensity;
  uniform float px;
  uniform float shineSize;
  uniform float shineFade;
  uniform float thickness;
  out vec4 fragColor;

  float roundedRect(vec2 point) {
    vec2 edge = abs(point) - halfSize + radius;
    return length(max(edge, 0.0)) + min(max(edge.x, edge.y), 0.0) - radius;
  }

  float gaussianLine(float distanceToEdge, float sigma) {
    float normalized = distanceToEdge / (sigma + 0.000001);
    float falloff = mix(1.0, 1.6, smoothstep(0.0, 1.5, normalized));
    return exp(-falloff * normalized * normalized);
  }

  void main() {
    vec2 point = gl_FragCoord.xy - center;
    float distanceToEdge = roundedRect(point);
    vec2 light = vec2(cos(angle), sin(angle));
    vec2 normal = normalize(point / halfSize + 0.000001);
    float phi = acos(clamp(abs(dot(normal, light)), 0.0, 1.0));
    float rim = 1.0 - smoothstep(
      shineSize - shineFade,
      shineSize + shineFade + 0.0001,
      phi
    );
    float line = gaussianLine(distanceToEdge, thickness);
    float edgeClamp = 1.0 - smoothstep(
      0.5 * px,
      3.0 * px,
      abs(distanceToEdge)
    );
    float shine = line * rim * edgeClamp * intensity;
    fragColor = vec4(lineColor * shine, shine);
  }
`;

interface SpecularComposerEffectProps {
  targetRef: RefObject<HTMLDivElement | null>;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

export function SpecularComposerEffect({
  targetRef,
}: SpecularComposerEffectProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const theme = useTheme();
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const target = targetRef.current;
    const host = hostRef.current;
    if (!target || !host || reducedMotion) {
      return undefined;
    }

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    if (!gl) return undefined;

    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      FRAGMENT_SHADER,
    );
    const program = gl.createProgram();
    if (!vertexShader || !fragmentShader || !program) {
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      if (program) gl.deleteProgram(program);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return undefined;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return undefined;
    }

    const buffer = gl.createBuffer();
    if (!buffer) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return undefined;
    }

    host.appendChild(canvas);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    const center = gl.getUniformLocation(program, 'center');
    const halfSize = gl.getUniformLocation(program, 'halfSize');
    const lineColor = gl.getUniformLocation(program, 'lineColor');
    const radius = gl.getUniformLocation(program, 'radius');
    const angleUniform = gl.getUniformLocation(program, 'angle');
    const intensity = gl.getUniformLocation(program, 'intensity');
    const px = gl.getUniformLocation(program, 'px');
    const shineSize = gl.getUniformLocation(program, 'shineSize');
    const shineFade = gl.getUniformLocation(program, 'shineFade');
    const thickness = gl.getUniformLocation(program, 'thickness');

    let dpr = window.devicePixelRatio || 1;
    let width = 1;
    let height = 1;
    let cornerRadius = 12;
    let pointerAngle: number | null = null;
    let angle = 2.4;
    let idleAngle = 2.4;
    let proximity = 0;
    let brightness = 0;
    let focused = false;
    let lastFrame = performance.now();
    let frameId = 0;
    let running = false;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      const rect = target.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      cornerRadius =
        Number.parseFloat(getComputedStyle(target).borderRadius) || 12;
      canvas.width = Math.ceil((width + 40) * dpr);
      canvas.height = Math.ceil((height + 40) * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const isEditorTarget = (eventTarget: EventTarget | null) => {
      const editor = target.querySelector('[data-web-shell-composer-editor]');
      return (
        eventTarget instanceof Node && Boolean(editor?.contains(eventTarget))
      );
    };

    const startLoop = () => {
      if (!running && !disposed) {
        running = true;
        lastFrame = performance.now();
        frameId = window.requestAnimationFrame(draw);
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = target.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = Math.max(
        rect.left - event.clientX,
        0,
        event.clientX - rect.right,
      );
      const dy = Math.max(
        rect.top - event.clientY,
        0,
        event.clientY - rect.bottom,
      );
      const distance = Math.hypot(dx, dy);
      if (distance === 0) {
        const normalizedX =
          (event.clientX - centerX) / Math.max(rect.width / 2, 1);
        const normalizedY =
          (centerY - event.clientY) / Math.max(rect.height / 2, 1);
        pointerAngle =
          Math.atan2(2 / rect.height, -2 / rect.width) +
          normalizedX * 0.3 +
          normalizedY * 0.15;
      } else {
        pointerAngle = Math.atan2(
          centerY - event.clientY,
          event.clientX - centerX,
        );
      }
      const amount = Math.max(0, 1 - distance / 250);
      proximity = amount * amount * (3 - 2 * amount);
      startLoop();
    };

    const onPointerLeave = () => {
      proximity = 0;
      pointerAngle = null;
    };

    const onFocusIn = (event: FocusEvent) => {
      if (!isEditorTarget(event.target)) return;
      pointerAngle = angle;
      idleAngle = angle;
      focused = true;
      startLoop();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (
        isEditorTarget(event.target) &&
        !isEditorTarget(event.relatedTarget)
      ) {
        pointerAngle = angle;
        focused = false;
      }
    };

    const draw = (now: number) => {
      const delta = Math.min((now - lastFrame) / 1000, 0.05);
      lastFrame = now;
      if (focused) idleAngle -= 0.85 * delta;
      else idleAngle = angle;
      const targetAngle = focused
        ? idleAngle
        : pointerAngle === null
          ? angle
          : pointerAngle;
      const difference =
        ((((targetAngle - angle + Math.PI) % (Math.PI * 2)) + Math.PI * 2) %
          (Math.PI * 2)) -
        Math.PI;
      angle += difference * (1 - Math.exp(-delta * 7));
      const targetBrightness = focused ? 1.4 : proximity;
      brightness +=
        (targetBrightness - brightness) * (1 - Math.exp(-delta * 8));

      if (brightness < 0.002 && !focused && proximity < 0.002) {
        running = false;
        frameId = 0;
        gl.clear(gl.COLOR_BUFFER_BIT);
        return;
      }

      gl.uniform2f(center, (20 + width / 2) * dpr, (20 + height / 2) * dpr);
      gl.uniform2f(halfSize, (width / 2) * dpr, (height / 2) * dpr);
      gl.uniform3f(
        lineColor,
        theme === WebShellThemeId.Light ? 0.2 : 0.403922,
        theme === WebShellThemeId.Light ? 0.360784 : 0.521569,
        1,
      );
      gl.uniform1f(radius, Math.min(cornerRadius, height / 2) * dpr);
      gl.uniform1f(angleUniform, angle);
      gl.uniform1f(intensity, brightness);
      gl.uniform1f(px, dpr);
      gl.uniform1f(shineSize, (32 * Math.PI) / 180);
      gl.uniform1f(shineFade, (68 * Math.PI) / 180);
      gl.uniform1f(thickness, 0.5 * dpr);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      frameId = window.requestAnimationFrame(draw);
    };

    const resizeObserver = new ResizeObserver(resize);
    let disposed = false;
    const teardown = () => {
      if (disposed) return;
      disposed = true;
      running = false;
      window.cancelAnimationFrame(frameId);
      frameId = 0;
      resizeObserver.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener(
        'pointerleave',
        onPointerLeave,
      );
      target.removeEventListener('focusin', onFocusIn);
      target.removeEventListener('focusout', onFocusOut);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.remove();
    };
    const onContextLost = () => {
      teardown();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);
    resizeObserver.observe(target);
    resize();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    target.addEventListener('focusin', onFocusIn);
    target.addEventListener('focusout', onFocusOut);
    const activeElement = document.activeElement;
    focused =
      activeElement !== null &&
      target
        .querySelector('[data-web-shell-composer-editor]')
        ?.contains(activeElement) === true;
    startLoop();

    return () => {
      teardown();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [reducedMotion, targetRef, theme]);

  return (
    <span
      ref={hostRef}
      className={styles.specularEffect}
      data-web-shell-composer-specular
      data-theme={theme}
      aria-hidden="true"
    />
  );
}
