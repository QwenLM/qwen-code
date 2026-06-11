/**
 * MessagingPlatformIcon
 *
 * Parallel of ConnectionIcon (for LLM providers) but for messaging platforms.
 * Renders the brand mark for Telegram / WhatsApp. Falls back to a colored
 * platform-initial badge if the SVG import fails at runtime.
 *
 * SVGs in `assets/messaging-icons/` are shorthand brand marks tuned for a
 * prototype — for production we should swap in the official marks from each
 * platform's press kit.
 */

import telegramIcon from '@/assets/messaging-icons/telegram.svg'
import whatsappIcon from '@/assets/messaging-icons/whatsapp.svg'

type MessagingPlatform = 'telegram' | 'whatsapp'

const platformIcons: Record<MessagingPlatform, string> = {
  telegram: telegramIcon,
  whatsapp: whatsappIcon,
}

const platformFallback: Record<MessagingPlatform, { bg: string; initial: string }> = {
  telegram: { bg: '#229ED9', initial: 'T' },
  whatsapp: { bg: '#25D366', initial: 'W' },
}

interface MessagingPlatformIconProps {
  platform: MessagingPlatform
  /** Size in pixels (default: 16). */
  size?: number
  className?: string
}

export function MessagingPlatformIcon({
  platform,
  size = 16,
  className = '',
}: MessagingPlatformIconProps) {
  const src = platformIcons[platform]
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={`rounded-[3px] flex-shrink-0 ${className}`}
        style={{ width: size, height: size }}
      />
    )
  }

  const { bg, initial } = platformFallback[platform]
  return (
    <div
      className={`rounded-[3px] flex items-center justify-center flex-shrink-0 text-white font-semibold ${className}`}
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.round(size * 0.6) }}
    >
      {initial}
    </div>
  )
}
