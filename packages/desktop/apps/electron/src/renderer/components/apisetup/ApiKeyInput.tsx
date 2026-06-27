import { SquareTerminal } from "lucide-react"
import { useTranslation } from "react-i18next"

export type ApiKeyStatus = 'idle' | 'validating' | 'success' | 'error'
export type CustomEndpointApi = never

export interface ApiKeySubmitData {
  apiKey: string
}

export interface ApiKeyInputProps {
  status: ApiKeyStatus
  errorMessage?: string
  onSubmit: (data: ApiKeySubmitData) => void
  formId?: string
  disabled?: boolean
  providerType?: 'qwen'
  initialValues?: {
    apiKey?: string
  }
}

export function ApiKeyInput({
  status,
  errorMessage,
  onSubmit,
  formId = "api-key-form",
  disabled,
}: ApiKeyInputProps) {
  const { t } = useTranslation()

  return (
    <form
      id={formId}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit({ apiKey: '' })
      }}
      className="space-y-3"
    >
      <div className="flex items-start gap-3 rounded-xl bg-foreground-2 p-4 text-sm text-muted-foreground">
        <SquareTerminal className="mt-0.5 size-4 shrink-0" />
        <p>{t("apiSetup.localAuthNotice")}</p>
      </div>
      {status === 'error' && errorMessage && (
        <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">
          {errorMessage}
        </div>
      )}
      <button type="submit" disabled={disabled || status === 'validating'} className="hidden" />
    </form>
  )
}
