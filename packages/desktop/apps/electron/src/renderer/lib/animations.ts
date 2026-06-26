/**
 * Shared animation configurations for synchronized animations across components
 */

// Easing curves for fullscreen overlay animations
// Entry: exponential out - fast start, smooth deceleration (responsive feel)
export const overlayEaseIn = [0.16, 1, 0.3, 1] as const  // expo-out

// Exit: exponential in - slow start, accelerates away (feels "pulled away")
export const overlayEaseOut = [0.7, 0, 0.84, 0] as const  // expo-in

// Tween config for entry animation
export const overlayTransitionIn = {
  duration: 0.4,
  ease: overlayEaseIn,
}

// Tween config for exit animation
export const overlayTransitionOut = {
  duration: 0.3,
  ease: overlayEaseOut,
}

// Scale-back values for AppShell when overlay is open
export const scaleBackValues = {
  scale: 0.92,
  y: 20,
  borderRadius: 16,
}
