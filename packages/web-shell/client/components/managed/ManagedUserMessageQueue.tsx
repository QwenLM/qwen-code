import { useState } from 'react';
import { useI18n } from '../../i18n';
import { Button } from '../ui/button';
import type { ManagedInputBlock } from './managed-agent-provider';
import type {
  ManagedUserMessageCommand,
  ManagedUserMessageSnapshot,
} from './use-managed-user-messages';

export function ManagedUserMessageQueue({
  snapshot,
  command,
}: {
  snapshot: ManagedUserMessageSnapshot;
  command: (command: ManagedUserMessageCommand) => Promise<void>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{
    id: string;
    revision: number;
    text: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = async (operation: ManagedUserMessageCommand) => {
    setBusy(true);
    setError(undefined);
    try {
      await command(operation);
      setEditing(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  if (!snapshot.messages.length && !snapshot.paused) return null;
  return (
    <section
      aria-label={t('managed.queue.title')}
      className="flex flex-col gap-2 p-2 text-sm"
    >
      <div>
        {t('managed.queue.title')}
        {snapshot.paused && ` · ${t('managed.queue.paused')}`}
      </div>
      {snapshot.paused && (
        <Button
          disabled={
            busy ||
            snapshot.messages.some(
              (message) => message.state === 'recovery_blocked',
            )
          }
          onClick={() => void run({ action: 'resume' })}
        >
          {t('managed.queue.resume')}
        </Button>
      )}
      {snapshot.messages.map((message) => (
        <div
          key={message.id}
          className="flex flex-col gap-1 rounded border p-2"
        >
          {editing?.id === message.id ? (
            <textarea
              aria-label={t('managed.queue.edit')}
              value={editing.text}
              onChange={(event) =>
                setEditing({ ...editing, text: event.target.value })
              }
            />
          ) : (
            <div className="whitespace-pre-wrap">
              {message.input
                .map(
                  (block) =>
                    block.text ??
                    (block.resource
                      ? decodeURIComponent(
                          block.resource.uri.slice('managed-input:///'.length),
                        )
                      : ''),
                )
                .join('\n')}
            </div>
          )}
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>
              {t(
                message.state === 'queued'
                  ? 'managed.queue.waiting'
                  : message.state === 'claimed'
                    ? 'managed.queue.claimed'
                    : 'managed.queue.blocked',
              )}
            </span>
            {(message.state === 'queued' ||
              (message.state === 'recovery_blocked' && !message.turnId)) && (
              <>
                {message.state === 'queued' && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setEditing({
                        id: message.id,
                        revision: message.revision,
                        text: message.input
                          .filter((block) => block.type === 'text')
                          .map((block) => block.text)
                          .join('\n'),
                      })
                    }
                  >
                    {t('managed.queue.edit')}
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run({
                      action: 'withdraw',
                      messageId: message.id,
                      expectedRevision: message.revision,
                    })
                  }
                >
                  {t('managed.queue.withdraw')}
                </Button>
              </>
            )}
            {editing?.id === message.id && (
              <>
                <Button
                  size="sm"
                  disabled={busy || !editing.text.trim()}
                  onClick={() => {
                    const files: ManagedInputBlock[] = message.input.flatMap(
                      (block) =>
                        block.resource
                          ? [
                              {
                                type: 'input_file' as const,
                                name: decodeURIComponent(
                                  block.resource.uri.slice(
                                    'managed-input:///'.length,
                                  ),
                                ),
                                mime_type: block.resource.mimeType,
                                text: block.resource.text,
                              },
                            ]
                          : [],
                    );
                    void run({
                      action: 'edit',
                      messageId: message.id,
                      expectedRevision: editing.revision,
                      input: [
                        { type: 'input_text', text: editing.text },
                        ...files,
                      ],
                    });
                  }}
                >
                  {t('managed.queue.save')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => setEditing(undefined)}
                >
                  {t('managed.queue.cancelEdit')}
                </Button>
              </>
            )}
          </div>
        </div>
      ))}
      {error && <div role="alert">{error}</div>}
    </section>
  );
}
