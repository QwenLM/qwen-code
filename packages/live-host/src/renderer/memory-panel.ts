import type { HostPublicState, LiveHostApi } from '../shared/host-api.ts';
import type { MemoryAction, MemoryState } from '../shared/protocol.ts';
import { parseMemoryAction } from '../shared/protocol.ts';
import {
  liveText,
  displayLiveMessage,
  type LiveMessageKey,
} from '@qwen-code/qwen-live/i18n';
import { uiText, uiLabel, localizeUi } from './ui-text.ts';

function control(label: LiveMessageKey, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  uiText(button, label);
  button.addEventListener('click', action);
  return button;
}

function field(label: LiveMessageKey, input: HTMLElement): HTMLLabelElement {
  const row = document.createElement('label');
  row.className = 'memory-field';
  const title = document.createElement('span');
  uiText(title, label);
  row.append(title, input);
  return row;
}

export class MemoryPanel {
  readonly element = document.createElement('section');
  private readonly enabled = document.createElement('input');
  private readonly visualEnabled = document.createElement('input');
  private readonly library = document.createElement('select');
  private readonly create = control('ui.memoryNew', () =>
    this.editName('create'),
  );
  private readonly rename = control('ui.memoryRename', () =>
    this.editName('rename'),
  );
  private readonly nameForm = document.createElement('form');
  private readonly nameInput = document.createElement('input');
  private readonly nameLabel = document.createElement('label');
  private readonly saveName = control('ui.save', () => void this.submitName());
  private readonly cancelName = control('ui.cancel', () =>
    this.cancelNameEdit(),
  );
  private readonly modelForm = document.createElement('form');
  private readonly model = document.createElement('input');
  private readonly saveModel = control(
    'ui.saveModel',
    () => void this.submitModel(),
  );
  private readonly notice = document.createElement('p');
  private readonly status = document.createElement('p');
  private state: HostPublicState | undefined;
  private memory: MemoryState | undefined;
  private nameEdit:
    | { action: 'create' }
    | { action: 'rename'; libraryId: string }
    | undefined;
  private modelDirty = false;
  private busy = false;
  private error = '';
  private libraryOptions = '';

  constructor(private readonly api: Pick<LiveHostApi, 'memoryAction'>) {
    this.element.hidden = true;
    this.element.className = 'memory-settings';
    this.element.dataset.liveInteractive = '';
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-labelledby', 'memory-panel-title');

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.id = 'memory-panel-title';
    uiText(title, 'ui.memory');
    header.append(title);

    const body = document.createElement('div');
    body.className = 'memory-panel-body';
    this.enabled.type = this.visualEnabled.type = 'checkbox';
    this.enabled.addEventListener('change', () => {
      void this.runAction({
        action: 'set_enabled',
        enabled: this.enabled.checked,
      });
    });
    this.visualEnabled.addEventListener('change', () => {
      void this.runAction({
        action: 'set_visual_enabled',
        enabled: this.visualEnabled.checked,
      });
    });
    const enabledRow = field('ui.memoryEnable', this.enabled);
    const visualRow = field('ui.memoryVisual', this.visualEnabled);
    enabledRow.classList.add('memory-toggle');
    visualRow.classList.add('memory-toggle');
    const visualHint = document.createElement('p');
    visualHint.className = 'memory-hint';
    uiText(visualHint, 'ui.memoryVisualHint');

    uiLabel(this.library, 'ui.memoryLibrary');
    this.library.addEventListener('change', () => {
      void this.runAction({ action: 'select', libraryId: this.library.value });
    });
    const libraryActions = document.createElement('div');
    libraryActions.className = 'memory-actions';
    libraryActions.append(this.create, this.rename);

    this.nameInput.type = 'text';
    this.nameInput.maxLength = 160;
    this.nameInput.autocomplete = 'off';
    this.nameInput.id = 'memory-library-name';
    this.nameLabel.htmlFor = this.nameInput.id;
    this.nameInput.addEventListener('input', () => this.render());
    this.nameForm.className = 'memory-name-form';
    this.nameForm.hidden = true;
    const nameActions = document.createElement('div');
    nameActions.className = 'memory-actions';
    nameActions.append(this.saveName, this.cancelName);
    this.nameForm.append(this.nameLabel, this.nameInput, nameActions);
    this.nameForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitName();
    });

    this.model.type = 'text';
    this.model.maxLength = 256;
    this.model.autocomplete = 'off';
    this.model.spellcheck = false;
    uiLabel(this.model, 'ui.memoryModel');
    this.model.addEventListener('input', () => {
      this.modelDirty = true;
      this.render();
    });
    this.modelForm.className = 'memory-model-form';
    this.modelForm.append(field('ui.memoryModel', this.model), this.saveModel);
    this.modelForm.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submitModel();
    });
    this.notice.className = 'memory-hint';
    this.status.className = 'memory-status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    body.append(
      enabledRow,
      visualRow,
      visualHint,
      field('ui.memoryLibrary', this.library),
      libraryActions,
      this.nameForm,
      this.modelForm,
      this.notice,
      this.status,
    );
    this.element.append(header, body);
  }

  update(state: HostPublicState): void {
    this.state = state;
    if (state.memory) this.memory = state.memory;
    this.element.hidden = !state.memory;
    this.render();
  }

  private render(): void {
    const memory = this.memory;
    if (!memory) return;
    const language = this.state?.language ?? 'en';
    localizeUi(this.element, language);
    this.nameLabel.textContent = liveText(
      language,
      this.nameEdit?.action === 'create'
        ? 'ui.newLibraryName'
        : 'ui.renameLibrary',
    );
    const unavailable =
      this.state?.connection !== 'ready' || !this.state.memory;
    const disabled = this.busy || unavailable;
    this.enabled.checked = memory.enabled;
    this.enabled.disabled = disabled;
    this.visualEnabled.checked = memory.visualEnabled;
    this.visualEnabled.disabled = disabled || !memory.enabled;
    this.library.disabled = disabled || memory.locked || Boolean(this.nameEdit);
    this.create.disabled = disabled || memory.locked;
    this.rename.disabled =
      disabled ||
      !memory.libraries.some((library) => library.id === memory.libraryId);
    const options = JSON.stringify(memory.libraries);
    if (options !== this.libraryOptions) {
      this.libraryOptions = options;
      this.library.replaceChildren();
      for (const item of memory.libraries) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.name;
        this.library.append(option);
      }
    }
    this.library.value = memory.libraryId;
    this.nameForm.hidden = !this.nameEdit;
    const nameLocked = this.nameEdit?.action === 'create' && memory.locked;
    this.nameInput.disabled = disabled || nameLocked;
    this.cancelName.disabled = this.busy;
    this.saveName.disabled =
      disabled ||
      nameLocked ||
      !parseMemoryAction({ ...this.nameEdit, name: this.nameInput.value });
    if (!this.modelDirty) this.model.value = memory.model;
    this.model.disabled = disabled || memory.locked;
    this.saveModel.disabled =
      disabled ||
      memory.locked ||
      this.model.value.trim() === memory.model ||
      !parseMemoryAction({ action: 'set_model', model: this.model.value });
    this.notice.textContent = memory.locked
      ? liveText(language, 'ui.memoryLockedHint')
      : liveText(language, 'ui.memorySavedHint');
    this.status.textContent = unavailable
      ? liveText(language, 'ui.memoryConnectHint')
      : this.busy
        ? liveText(language, 'ui.saving')
        : displayLiveMessage(language, this.error || memory.error || '');
    this.status.classList.toggle(
      'error',
      !this.busy && Boolean(this.error || memory.error),
    );
  }

  private editName(action: 'create' | 'rename'): void {
    if (!this.memory || this.busy) return;
    const current = this.memory.libraries.find(
      (library) => library.id === this.memory?.libraryId,
    );
    if (action === 'rename' && !current) return;
    this.nameEdit =
      action === 'create'
        ? { action }
        : { action, libraryId: this.memory.libraryId };
    this.nameInput.value = action === 'rename' ? (current?.name ?? '') : '';
    this.error = '';
    this.render();
    this.nameInput.focus();
    this.nameInput.select();
  }

  private cancelNameEdit(): void {
    this.nameEdit = undefined;
    this.render();
  }

  private async submitName(): Promise<void> {
    const action = parseMemoryAction({
      ...this.nameEdit,
      name: this.nameInput.value,
    });
    if (!action || this.saveName.disabled) return;
    if (await this.runAction(action)) this.cancelNameEdit();
  }

  private async submitModel(): Promise<void> {
    const action = parseMemoryAction({
      action: 'set_model',
      model: this.model.value,
    });
    if (!action || this.saveModel.disabled) return;
    if (await this.runAction(action)) {
      this.modelDirty = false;
      this.render();
    }
  }

  private async runAction(action: MemoryAction): Promise<boolean> {
    if (this.busy || this.state?.connection !== 'ready') return false;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      this.memory = await this.api.memoryAction(action);
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
