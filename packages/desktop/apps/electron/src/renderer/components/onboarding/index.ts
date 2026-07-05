// Shared primitives for building step components
export {
  StepIcon,
  StepHeader,
  StepFormLayout,
  StepActions,
  BackButton,
  ContinueButton,
  type StepIconVariant,
} from './primitives'

// Individual steps
export { ProviderSelectStep, type ProviderChoice } from './ProviderSelectStep'
export { WelcomeStep } from './WelcomeStep'
export { APISetupStep, type ApiSetupMethod } from './APISetupStep'
export { CredentialsStep, type CredentialStatus } from './CredentialsStep'
export { CompletionStep } from './CompletionStep'
export { ReauthScreen } from './ReauthScreen'
export { GitBashWarning, type GitBashStatus } from './GitBashWarning'

// Main wizard container
export { OnboardingWizard, type OnboardingState, type OnboardingStep, type LoginStatus } from './OnboardingWizard'

// Re-export all types for convenient import
export type {
  OnboardingStep as OnboardingStepType,
  OnboardingState as OnboardingStateType,
} from './OnboardingWizard'

export type {
  ApiSetupMethod as ApiSetupMethodType,
} from './APISetupStep'

export type {
  CredentialStatus as CredentialStatusType,
} from './CredentialsStep'
