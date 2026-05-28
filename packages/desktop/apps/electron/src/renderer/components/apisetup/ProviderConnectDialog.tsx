import { Dialog, DialogContent } from '@/components/ui/dialog';
import type { QwenProviderConnectResult } from '../../../shared/types';
import { ProviderConnectForm } from './ProviderConnectForm';

interface ProviderConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (result: QwenProviderConnectResult) => void;
  activeSessionId?: string | null;
}

export function ProviderConnectDialog({
  open,
  onOpenChange,
  onConnected,
  activeSessionId,
}: ProviderConnectDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <ProviderConnectForm
          activeSessionId={activeSessionId}
          onConnected={(result) => {
            onConnected(result);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
