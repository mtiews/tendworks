import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * Asks the operator to confirm an action before it happens (e.g. deciding an approval request,
 * ending a chat): an inline, non-modal `alertdialog` named by `title`, described by `children`.
 * It takes the focus on its safe choice (Cancel); Cancel and Escape close it and hand the focus
 * back to the element that opened it. While `busy`, both choices are disabled; without
 * `canConfirm` (e.g. nothing chosen yet), only the confirming one.
 */
export function Confirmation({
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  cancelLabel = "Cancel",
  busy = false,
  canConfirm = true,
  children,
}: {
  title: string;
  confirmLabel: string;
  /** The safe choice's label, e.g. when the confirmed choice itself is called "Cancel". */
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  canConfirm?: boolean;
  children?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // Read while rendering, before the effect moves the focus (and twice in strict mode).
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    cancel.current?.focus();
  }, []);

  const close = () => {
    onCancel();
    if (opener instanceof HTMLElement) opener.focus();
  };

  return (
    <div
      className="confirmation"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={children === undefined ? undefined : descriptionId}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <p className="confirmation-title" id={titleId}>
        {title}
      </p>
      {children !== undefined && <div id={descriptionId}>{children}</div>}
      <div className="confirmation-actions">
        <button type="button" className="primary" disabled={busy || !canConfirm} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" ref={cancel} disabled={busy} onClick={close}>
          {cancelLabel}
        </button>
      </div>
    </div>
  );
}
