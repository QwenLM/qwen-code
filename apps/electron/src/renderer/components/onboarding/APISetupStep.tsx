import { useState } from "react"
import { useTranslation } from "react-i18next"
import { cn } from "@/lib/utils"
import { Check, CreditCard, Key, Cpu, SquareTerminal } from "lucide-react"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import type { LlmAuthType, LlmProviderType } from "@craft-agent/shared/config/llm-connections"

/** Provider segment for the segmented control */
export type ProviderSegment = 'anthropic' | 'pi' | 'qwen'

const BetaBadge = ({ label }: { label: string }) => (
  <span className="inline px-1.5 pt-[2px] pb-[3px] text-[10px] font-accent font-bold rounded-[4px] bg-accent text-background ml-1 relative -top-[1px]">
    {label}
  </span>
)

/**
 * API setup method for onboarding.
 * Maps to specific LlmProviderType + LlmAuthType combinations.
 *
 * - 'claude_oauth' → anthropic + oauth
 * - 'anthropic_api_key' → anthropic + api_key
 * - 'pi_chatgpt_oauth' → pi + oauth
 * - 'pi_copilot_oauth' → pi + oauth
 * - 'pi_api_key' → pi + api_key
 * - 'qwen_code' → qwen + none
 */
export type ApiSetupMethod =
  | 'anthropic_api_key'
  | 'claude_oauth'
  | 'pi_chatgpt_oauth'
  | 'pi_copilot_oauth'
  | 'pi_api_key'
  | 'qwen_code'

/**
 * Map ApiSetupMethod to the underlying LLM connection types.
 */
export function apiSetupMethodToConnectionTypes(method: ApiSetupMethod): {
  providerType: LlmProviderType;
  authType: LlmAuthType;
} {
  switch (method) {
    case 'claude_oauth':
      return { providerType: 'anthropic', authType: 'oauth' };
    case 'anthropic_api_key':
      return { providerType: 'anthropic', authType: 'api_key' };
    case 'pi_chatgpt_oauth':
      return { providerType: 'pi', authType: 'oauth' };
    case 'pi_copilot_oauth':
      return { providerType: 'pi', authType: 'oauth' };
    case 'pi_api_key':
      return { providerType: 'pi', authType: 'api_key' };
    case 'qwen_code':
      return { providerType: 'qwen', authType: 'none' };
  }
}

interface ApiSetupOption {
  id: ApiSetupMethod
  name: string
  description: string
  icon: React.ReactNode
  providerType: LlmProviderType
}

const API_SETUP_ICONS: Record<ApiSetupMethod, React.ReactNode> = {
  claude_oauth: <CreditCard className="size-4" />,
  anthropic_api_key: <Key className="size-4" />,
  pi_chatgpt_oauth: <Cpu className="size-4" />,
  pi_copilot_oauth: <Cpu className="size-4" />,
  pi_api_key: <Key className="size-4" />,
  qwen_code: <SquareTerminal className="size-4" />,
}

interface APISetupStepProps {
  selectedMethod: ApiSetupMethod | null
  onSelect: (method: ApiSetupMethod) => void
  onContinue: () => void
  onBack: () => void
  /** Initial segment to show (defaults to 'anthropic') */
  initialSegment?: ProviderSegment
}

/**
 * Individual option button component
 */
function OptionButton({
  option,
  isSelected,
  onSelect,
}: {
  option: ApiSetupOption
  isSelected: boolean
  onSelect: (method: ApiSetupMethod) => void
}) {
  return (
    <button
      onClick={() => onSelect(option.id)}
      className={cn(
        "flex w-full items-start gap-4 rounded-xl p-4 text-left transition-all",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "hover:bg-foreground/[0.02] shadow-minimal",
        isSelected
          ? "bg-background"
          : "bg-foreground-2"
      )}
    >
      {/* Icon */}
      <div
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          isSelected ? "bg-foreground/10 text-foreground" : "bg-muted text-muted-foreground"
        )}
      >
        {option.icon}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{option.name}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {option.description}
        </p>
      </div>

      {/* Check */}
      <div
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          isSelected
            ? "border-foreground bg-foreground text-background"
            : "border-muted-foreground/20"
        )}
      >
        {isSelected && <Check className="size-3" strokeWidth={3} />}
      </div>
    </button>
  )
}

/**
 * Segmented control for provider selection
 */
function ProviderSegmentedControl({
  activeSegment,
  onSegmentChange,
  segmentLabels,
}: {
  activeSegment: ProviderSegment
  onSegmentChange: (segment: ProviderSegment) => void
  segmentLabels: Record<ProviderSegment, string>
}) {
  const segments: ProviderSegment[] = ['anthropic', 'pi', 'qwen']

  return (
    <div className="flex rounded-xl bg-foreground/[0.03] p-1 mb-4">
      {segments.map((segment) => (
        <button
          key={segment}
          onClick={() => onSegmentChange(segment)}
          className={cn(
            "flex-1 px-4 py-2 text-sm font-medium rounded-lg transition-all",
            activeSegment === segment
              ? "bg-background shadow-minimal text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {segmentLabels[segment]}
        </button>
      ))}
    </div>
  )
}

/**
 * APISetupStep - Choose how to connect your AI agents
 *
 * Features a segmented control to filter by provider:
 * - Anthropic - Claude Pro/Max or API Key
 * - OpenAI - ChatGPT Plus/Pro or API Key
 * - GitHub Copilot - Copilot subscription
 */
export function APISetupStep({
  selectedMethod,
  onSelect,
  onContinue,
  onBack,
  initialSegment = 'anthropic',
}: APISetupStepProps) {
  const { t } = useTranslation()
  const [activeSegment, setActiveSegment] = useState<ProviderSegment>(initialSegment)

  const SEGMENT_LABELS: Record<ProviderSegment, string> = {
    anthropic: t("onboarding.apiSetup.claude"),
    pi: t("onboarding.apiSetup.craftAgentsBackend"),
    qwen: 'Qwen Code',
  }

  const SEGMENT_DESCRIPTIONS: Record<ProviderSegment, React.ReactNode> = {
    anthropic: <>{t("onboarding.apiSetup.claudeDesc")}</>,
    pi: <>{t("onboarding.apiSetup.piDesc")}<BetaBadge label={t("onboarding.apiSetup.beta")} /></>,
    qwen: <>Use the Qwen Code CLI as the main agent. Authentication stays in Qwen Code.</>,
  }

  const API_SETUP_OPTIONS: ApiSetupOption[] = [
    {
      id: 'claude_oauth',
      name: t("onboarding.apiSetup.claudeProMax"),
      description: t("onboarding.apiSetup.claudeProMaxDesc"),
      icon: API_SETUP_ICONS.claude_oauth,
      providerType: 'anthropic',
    },
    {
      id: 'anthropic_api_key',
      name: t("onboarding.apiSetup.anthropicApiKey"),
      description: t("onboarding.apiSetup.anthropicApiKeyDesc"),
      icon: API_SETUP_ICONS.anthropic_api_key,
      providerType: 'anthropic',
    },
    {
      id: 'pi_chatgpt_oauth',
      name: 'ChatGPT Plus',
      description: t("onboarding.apiSetup.chatGPTPlusDesc"),
      icon: API_SETUP_ICONS.pi_chatgpt_oauth,
      providerType: 'pi',
    },
    {
      id: 'pi_copilot_oauth',
      name: 'GitHub Copilot',
      description: t("onboarding.apiSetup.githubCopilotDesc"),
      icon: API_SETUP_ICONS.pi_copilot_oauth,
      providerType: 'pi',
    },
    {
      id: 'pi_api_key',
      name: t("onboarding.apiSetup.apiKey"),
      description: t("onboarding.apiSetup.apiKeyDesc"),
      icon: API_SETUP_ICONS.pi_api_key,
      providerType: 'pi',
    },
    {
      id: 'qwen_code',
      name: 'Qwen Code',
      description: 'Use your local Qwen Code CLI through ACP. No API key is stored in Craft.',
      icon: API_SETUP_ICONS.qwen_code,
      providerType: 'qwen',
    },
  ]

  // Filter options based on active segment
  const filteredOptions = API_SETUP_OPTIONS.filter(o => o.providerType === activeSegment)

  // Handle segment change - clear selection if it doesn't belong to new segment
  const handleSegmentChange = (segment: ProviderSegment) => {
    setActiveSegment(segment)
    // If current selection doesn't match the new segment, don't auto-clear
    // (user might want to keep it and switch back)
  }

  return (
    <StepFormLayout
      title={t("onboarding.apiSetup.title")}
      description={t("onboarding.apiSetup.description")}
      actions={
        <>
          <BackButton onClick={onBack} />
          <ContinueButton onClick={onContinue} disabled={!selectedMethod} />
        </>
      }
    >
      {/* Provider segmented control */}
      <ProviderSegmentedControl
        activeSegment={activeSegment}
        onSegmentChange={handleSegmentChange}
        segmentLabels={SEGMENT_LABELS}
      />

      {/* Segment description */}
      <div className="bg-foreground-2 rounded-[8px] p-4 mb-3">
        <p className="text-sm text-muted-foreground text-center">
          {SEGMENT_DESCRIPTIONS[activeSegment]}
        </p>
      </div>

      {/* Filtered options for selected provider - min-h keeps size consistent across tabs */}
      <div className="space-y-3 min-h-[180px]">
        {filteredOptions.map((option) => (
          <OptionButton
            key={option.id}
            option={option}
            isSelected={option.id === selectedMethod}
            onSelect={onSelect}
          />
        ))}
      </div>
    </StepFormLayout>
  )
}
