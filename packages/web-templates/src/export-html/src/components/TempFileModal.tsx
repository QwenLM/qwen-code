import './TempFileModal.css';

const React = window.React;

export type ModalState = {
  visible: boolean;
  content: string;
  fileName: string;
};

export const TempFileModal = ({
  state,
  onClose,
}: {
  state: ModalState;
  onClose: () => void;
}) => {
  // Lock body scroll when modal is visible
  React.useEffect(() => {
    if (state.visible) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [state.visible]);

  if (!state.visible) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-container" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title font-mono">{state.fileName}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <pre className="modal-content">{state.content}</pre>
      </div>
    </div>
  );
};

export const useModalState = () => {
  const [modalState, setModalState] = React.useState<ModalState>({
    visible: false,
    content: '',
    fileName: '',
  });

  const openModal = React.useCallback(
    (content: string, fileName: string = 'temp') => {
      setModalState({ visible: true, content, fileName });
    },
    [],
  );

  const closeModal = React.useCallback(() => {
    setModalState((prev) => ({ ...prev, visible: false }));
  }, []);

  return { modalState, openModal, closeModal };
};
