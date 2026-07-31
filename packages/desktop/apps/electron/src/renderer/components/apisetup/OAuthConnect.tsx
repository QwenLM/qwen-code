/**
 * OAuthConnect - Reusable OAuth connection control
 *
 * Renders content for two flow states:
 * 1. Waiting for code: Auth code input form (form ID binds to external submit button)
 * 2. Non-waiting: Error message display (if any)
 *
 * Does NOT include layout wrappers or action buttons — the parent controls
 * button placement and loading states. Error display follows the same pattern
 * as ApiKeyInput (shown below the content area).
 *
 * Used in: Onboarding CredentialsStep, Settings OAuth dialog
 */

import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export type OAuthStatus = 'idle' | 'validating' | 'success' | 'error'

export interface OAuthConnectProps {
  /** Current connection status */
  status: OAuthStatus
  /** Error message when status is 'error' */
  errorMessage?: string
  /** Whether we're waiting for user to paste an auth code */
  isWaitingForCode?: boolean
  /** Start the OAuth browser flow */
  onStartOAuth: () => void
  /** Submit the authorization code from the browser */
  onSubmitAuthCode?: (code: string) => void
  /** Cancel the OAuth flow (while waiting for code) */
  onCancelOAuth?: () => void
  /** Form ID for auth code form (default: "auth-code-form") */
  formId?: string
}

export function OAuthConnect({
  status,
  errorMessage,
  isWaitingForCode,
  onSubmitAuthCode,
  formId = "auth-code-form",
}: OAuthConnectProps) {
  const { t } = useTranslation()
  const [authCode, setAuthCode] = useState('')

  const handleAuthCodeSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (authCode.trim() && onSubmitAuthCode) {
      onSubmitAuthCode(authCode.trim())
    }
  }

  // Auth code entry form — shown when waiting for the user to paste the code
  if (isWaitingForCode) {
    return (
      <form id={formId} onSubmit={handleAuthCodeSubmit}>
        <div className="space-y-2">
          <Label htmlFor="auth-code">{t("apiSetup.authorizationCode")}</Label>
          <div className={cn(
            "relative rounded-md shadow-minimal transition-colors",
            "bg-foreground-2 focus-within:bg-background"
          )}>
            <Input
              id="auth-code"
              type="text"
              value={authCode}
              onChange={(e) => setAuthCode(e.target.value)}
              placeholder={t("apiSetup.pasteAuthCode")}
              className={cn(
                "border-0 bg-transparent shadow-none font-mono text-sm",
                status === 'error' && "focus-visible:ring-destructive"
              )}
              disabled={status === 'validating'}
              autoFocus
            />
          </div>
          {status === 'error' && errorMessage && (
            <p className="text-sm text-destructive">{errorMessage}</p>
          )}
        </div>
      </form>
    )
  }

  // Non-waiting states: show error message if present
  const showError = status === 'error' && !!errorMessage

  // Nothing to render — avoid empty wrapper div
  if (!showError) return null

  return (
    <div className="space-y-3">
      {/* Error message displayed below content, matching the API key pattern */}
      <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive text-center">
        {errorMessage}
      </div>
    </div>
  )
}
