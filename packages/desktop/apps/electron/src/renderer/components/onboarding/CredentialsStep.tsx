import { useTranslation } from 'react-i18next';
import type { ApiSetupMethod } from './APISetupStep';
import { StepFormLayout, BackButton } from './primitives';
import type { ApiKeyStatus, ApiKeySubmitData } from '../apisetup';
import { ProviderConnectForm } from '../apisetup';

export type CredentialStatus = ApiKeyStatus;

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod;
  status: CredentialStatus;
  errorMessage?: string;
  onSubmit: (data: ApiKeySubmitData) => void;
  onBack: () => void;
  editInitialValues?: {
    apiKey?: string;
    baseUrl?: string;
    connectionDefaultModel?: string;
    activePreset?: string;
    models?: string[];
  };
}

export function CredentialsStep({
  status,
  errorMessage,
  onSubmit,
  onBack,
}: CredentialsStepProps) {
  const { t } = useTranslation();

  return (
    <StepFormLayout
      title={t('providerConnect.title')}
      description={t('onboarding.credentials.providerDescription')}
      actions={
        <BackButton onClick={onBack} disabled={status === 'validating'} />
      }
    >
      <ProviderConnectForm
        showHeader={false}
        onConnected={() => onSubmit({ apiKey: '' })}
      />
      {status === 'error' && errorMessage && (
        <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">
          {errorMessage}
        </div>
      )}
    </StepFormLayout>
  );
}
