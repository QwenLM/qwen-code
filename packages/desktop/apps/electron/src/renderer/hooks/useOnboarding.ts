import { useState, useCallback, useEffect } from 'react'
import type {
  OnboardingState,
  OnboardingStep,
  ApiSetupMethod,
} from '@/components/onboarding'
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import type { ApiKeySubmitData } from '@/components/apisetup'
import type { SetupNeeds, LlmConnectionSetup } from '../../shared/types'

interface UseOnboardingOptions {
  onComplete: () => void
  initialSetupNeeds?: SetupNeeds
  initialStep?: OnboardingStep
  initialApiSetupMethod?: ApiSetupMethod
  onDismiss?: () => void
  onConfigSaved?: () => void
  editingSlug?: string | null
  existingSlugs?: Set<string>
}

interface UseOnboardingReturn {
  state: OnboardingState
  handleContinue: () => void
  handleBack: () => void
  handleSelectProvider: (choice: ProviderChoice) => void
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void
  handleSubmitCredential: (data: ApiKeySubmitData) => void
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void
  handleSkipSetup: () => void
  handleFinish: () => void
  handleCancel: () => void
  jumpToCredentials: (method: ApiSetupMethod) => void
  reset: () => void
}

export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  qwen_code: 'qwen-code',
}

export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  if (editingSlug) return editingSlug
  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base
  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

export function apiSetupMethodToConnectionSetup(
  method: ApiSetupMethod,
  _options: Record<string, unknown>,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): LlmConnectionSetup {
  return { slug: resolveSlugForMethod(method, editingSlug, existingSlugs) }
}

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'provider-select',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
}: UseOnboardingOptions): UseOnboardingReturn {
  const [state, setState] = useState<OnboardingState>({
    step: initialStep,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false,
    isCheckingGitBash: true,
  })

  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          ...(status.platform === 'win32' && !status.found ? { step: 'git-bash' as const } : {}),
        }))
      } catch {
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  const saveQwenConnection = useCallback(async (connectionSlugOverride?: string): Promise<boolean> => {
    setState(s => ({ ...s, completionStatus: 'saving' }))
    const setup = apiSetupMethodToConnectionSetup(
      'qwen_code',
      {},
      connectionSlugOverride ?? editingSlug,
      existingSlugs,
    )
    const result = await window.electronAPI.setupLlmConnection(setup)
    if (!result.success) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        completionStatus: 'saving',
        errorMessage: result.error || 'Failed to save Qwen Code configuration',
      }))
      return false
    }
    setState(s => ({ ...s, completionStatus: 'complete' }))
    onConfigSaved?.()
    return true
  }, [editingSlug, existingSlugs, onConfigSaved])

  const handleContinue = useCallback(() => {
    switch (state.step) {
      case 'welcome':
        setState(s => ({ ...s, step: 'provider-select' }))
        break
      case 'git-bash':
        setState(s => ({ ...s, step: 'provider-select' }))
        break
      case 'complete':
        onComplete()
        break
    }
  }, [state.step, onComplete])

  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    if (state.step === 'credentials') {
      setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
    } else if (onDismiss) {
      onDismiss()
    }
  }, [state.step, initialStep, onDismiss])

  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => ({ ...s, apiSetupMethod: method }))
  }, [])

  const handleSubmitCredential = useCallback(async (_data: ApiKeySubmitData) => {
    setState(s => ({ ...s, apiSetupMethod: 'qwen_code', credentialStatus: 'validating', errorMessage: undefined }))
    try {
      const testResult = await window.electronAPI.testLlmConnectionSetup({
        provider: 'qwen',
        apiKey: '',
      })
      if (!testResult.success) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Qwen Code connection test failed',
        }))
        return
      }
      const saved = await saveQwenConnection()
      setState(s => ({ ...s, credentialStatus: saved ? 'success' : 'error', step: saved ? 'complete' : s.step }))
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Qwen Code validation failed',
      }))
    }
  }, [saveQwenConnection])

  const handleSelectProvider = useCallback((_choice: ProviderChoice) => {
    setState(s => ({
      ...s,
      apiSetupMethod: 'qwen_code',
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))
  }, [])

  const handleBrowseGitBash = useCallback(async () => window.electronAPI.browseForGitBash(), [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'provider-select',
      }))
    } else {
      setState(s => ({ ...s, errorMessage: result.error || 'Invalid path' }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        step: status.found ? 'provider-select' : s.step,
      }))
    } catch {
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => ({ ...s, errorMessage: undefined }))
  }, [])

  const handleSkipSetup = useCallback(async () => {
    await window.electronAPI.deferSetup().catch(() => {})
    onComplete()
  }, [onComplete])

  const handleFinish = useCallback(() => onComplete(), [onComplete])

  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  const jumpToCredentials = useCallback((_method: ApiSetupMethod) => {
    setState(s => ({
      ...s,
      step: 'credentials',
      apiSetupMethod: 'qwen_code',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))
  }, [])

  const reset = useCallback(() => {
    setState({
      step: initialStep,
      loginStatus: 'idle',
      credentialStatus: 'idle',
      completionStatus: 'saving',
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: false,
      errorMessage: undefined,
      isCheckingGitBash: false,
    })
  }, [initialStep, initialApiSetupMethod])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    reset,
  }
}
