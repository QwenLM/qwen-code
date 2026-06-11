import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Cloud, Server, SlidersHorizontal } from 'lucide-react';
import { CraftAgentsSymbol } from '@/components/icons/CraftAgentsSymbol';
import { StepFormLayout } from './primitives';

export type ProviderChoice = 'alibaba' | 'third-party' | 'custom';

interface ProviderOption {
  id: ProviderChoice;
  name: string;
  description: string;
  icon: React.ReactNode;
}

const PROVIDER_ICONS: Record<ProviderChoice, React.ReactNode> = {
  alibaba: <Cloud className="size-5" />,
  'third-party': <Server className="size-5" />,
  custom: <SlidersHorizontal className="size-5" />,
};

interface ProviderSelectStepProps {
  /** Called when the user selects a provider */
  onSelect: (choice: ProviderChoice) => void;
  /** Called when the user chooses to skip setup */
  onSkip?: () => void;
}

/**
 * ProviderSelectStep — First screen after install.
 */
export function ProviderSelectStep({
  onSelect,
  onSkip,
}: ProviderSelectStepProps) {
  const { t } = useTranslation();

  const PROVIDER_OPTIONS: ProviderOption[] = [
    {
      id: 'alibaba',
      name: t('providerConnect.groups.alibaba.title'),
      description: t('providerConnect.groups.alibaba.description'),
      icon: PROVIDER_ICONS.alibaba,
    },
    {
      id: 'third-party',
      name: t('providerConnect.groups.third-party.title'),
      description: t('providerConnect.groups.third-party.description'),
      icon: PROVIDER_ICONS['third-party'],
    },
    {
      id: 'custom',
      name: t('providerConnect.groups.custom.title'),
      description: t('providerConnect.groups.custom.description'),
      icon: PROVIDER_ICONS.custom,
    },
  ];

  return (
    <StepFormLayout
      iconElement={
        <div className="flex size-16 items-center justify-center">
          <CraftAgentsSymbol className="size-10 text-accent" />
        </div>
      }
      title={t('providerConnect.title')}
      description={t('onboarding.providerSelect.description')}
    >
      <div className="space-y-3">
        {PROVIDER_OPTIONS.map((option) => (
          <button
            key={option.id}
            onClick={() => onSelect(option.id)}
            className={cn(
              'flex w-full items-start gap-4 rounded-xl bg-foreground-2 p-4 text-left transition-all',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'hover:bg-foreground/[0.02] shadow-minimal',
            )}
          >
            {/* Icon */}
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {option.icon}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <span className="font-medium text-sm">{option.name}</span>
              <p className="mt-0 text-xs text-muted-foreground">
                {option.description}
              </p>
            </div>
          </button>
        ))}
      </div>

      {onSkip && (
        <div className="mt-4 text-center">
          <button
            onClick={onSkip}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('onboarding.providerSelect.setupLater')}
          </button>
        </div>
      )}
    </StepFormLayout>
  );
}
