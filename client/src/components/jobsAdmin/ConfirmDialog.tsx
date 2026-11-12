import React, { useEffect, useId, useRef } from 'react';

interface ConfirmDialogProps {
    open: boolean;
    title: string;
    children?: React.ReactNode;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
}

/**
 * Confirmation dialog: role="alertdialog", aria-modal, labelled and described; focus starts on Cancel
 * (the safe choice), Tab / Shift+Tab stay inside, Escape cancels, focus returns to the opener on close.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
    open, title, children, confirmLabel, cancelLabel, danger, busy, onConfirm, onCancel,
}) => {
    const id = useId();
    const boxRef = useRef<HTMLDivElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const openerRef = useRef<Element | null>(null);

    useEffect(() => {
        if (!open) return;
        openerRef.current = document.activeElement;
        cancelRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); return; }
            if (e.key !== 'Tab' || !boxRef.current) return;
            const items = Array.from(boxRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            else if (!boxRef.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
        };
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            const opener = openerRef.current as HTMLElement | null;
            if (opener && document.contains(opener)) opener.focus();
        };
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!open) return null;
    return (
        <div className="jobs-admin-dialog__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
            <div
                ref={boxRef}
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-body`}
                className="jobs-admin-dialog"
            >
                <h2 id={`${id}-title`} className="jobs-admin-dialog__title">{title}</h2>
                <div id={`${id}-body`} className="jobs-admin-dialog__body">{children}</div>
                <div className="jobs-admin-dialog__actions">
                    <button
                        type="button"
                        className={`board-pill ${danger ? 'board-pill--danger' : 'board-pill--primary'}`}
                        onClick={onConfirm}
                        disabled={busy}
                    >
                        {confirmLabel}
                    </button>
                    <button ref={cancelRef} type="button" className="board-pill" onClick={onCancel}>{cancelLabel}</button>
                </div>
            </div>
        </div>
    );
};

export default ConfirmDialog;
