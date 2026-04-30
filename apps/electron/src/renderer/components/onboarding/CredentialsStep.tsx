import { SquareTerminal } from "lucide-react"
import type { ApiSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import type { ApiKeyStatus, ApiKeySubmitData } from "../apisetup"

export type CredentialStatus = ApiKeyStatus

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod
  status: CredentialStatus
  errorMessage?: string
  onSubmit: (data: ApiKeySubmitData) => void
  onBack: () => void
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
  }
}

export function CredentialsStep({
  status,
  errorMessage,
  onSubmit,
  onBack,
}: CredentialsStepProps) {
  return (
    <StepFormLayout
      title="Qwen Code"
      description="Use the Qwen Code CLI as the only backend."
      actions={
        <>
          <BackButton onClick={onBack} disabled={status === 'validating'} />
          <ContinueButton
            onClick={() => onSubmit({ apiKey: '' })}
            className="gap-2"
            loading={status === 'validating'}
            loadingText="Checking"
          >
            <SquareTerminal className="size-4" />
            Continue
          </ContinueButton>
        </>
      }
    >
      <div className="rounded-xl bg-foreground-2 p-4 text-sm text-muted-foreground">
        Make sure Qwen Code is installed and signed in locally. Craft will connect through ACP and will not store provider credentials.
      </div>
      {status === 'error' && errorMessage && (
        <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">
          {errorMessage}
        </div>
      )}
    </StepFormLayout>
  )
}
