import { create } from 'zustand';
import { modalStyleSetting } from '../models/types/modal.types';
import { ReactNode } from 'react';
import React from 'react';

export type InitModalParams = {
    active: boolean;
    modalTitle?: string;
    modalBody?: ReactNode;
    modalFooter?: ReactNode;
    modalStyle?: modalStyleSetting;
    onClose?: () => void;
};

type PendingModal = {
    modalTitle?: string;
    modalBody?: ReactNode;
    modalFooter?: ReactNode;
    modalStyle?: modalStyleSetting;
    onClose?: () => void;
};

type ModalStore = {
    active: boolean;
    modalTitle?: string;
    modalBody: ReactNode;
    modalFooter?: ReactNode;
    modalStyle?: modalStyleSetting;
    onClose: () => void;
    pendingModal: PendingModal | null; // Stores the explicitly set pending modal
    initModal: (params: InitModalParams) => void;
    storeCurrentModalAsPending: () => void; // Store the current modal as pending without opening another modal
    storeCurrentModalAsPendingAndOpenNew: (newModalParams: InitModalParams) => void; // Explicitly store and open a new modal
    closeModal: () => void; // Close the modal and handle reopening the pending modal
    openPendingModalIfExists: () => void; // Explicitly open the pending modal
};

const useModalStore = create<ModalStore>((set) => ({
    active: false,
    modalTitle: '',
    modalBody: React.createElement('div'),
    modalFooter: React.createElement('div'),
    modalStyle: {
        titleTypography: {
            titleClass: "",
            divTitleClass: "",
        },
        bodyClass: "",
    },
    onClose: () => { },
    pendingModal: null,

    initModal: ({ active, modalTitle, modalBody, modalFooter, modalStyle, onClose }: InitModalParams) => {
        set((state) => ({
            active,
            modalTitle: modalTitle,
            modalBody: modalBody,
            modalFooter: modalFooter,
            modalStyle: modalStyle ?? state.modalStyle,
            onClose: onClose ? onClose : () => { },
        }));
    },

    storeCurrentModalAsPending: () => {
        set((state) => {
            if (!state.active) return state; // Do nothing if no modal is active

            // Store the current modal as pending
            return {
                ...state,
                pendingModal: {
                    modalTitle: state.modalTitle,
                    modalBody: state.modalBody,
                    modalFooter: state.modalFooter,
                    modalStyle: state.modalStyle,
                    onClose: state.onClose,
                },
            };
        });
    },

    storeCurrentModalAsPendingAndOpenNew: ({ active, modalTitle, modalBody, modalFooter, modalStyle, onClose }: InitModalParams) => {
        set((state) => {
            // Store the current modal as pending
            const pendingModal: PendingModal = {
                modalTitle: state.modalTitle,
                modalBody: state.modalBody,
                modalFooter: state.modalFooter,
                modalStyle: state.modalStyle,
                onClose: state.onClose,
            };

            // Open the new modal
            return {
                active,
                modalTitle: modalTitle,
                modalBody: modalBody,
                modalFooter: modalFooter,
                modalStyle: modalStyle ?? state.modalStyle,
                onClose: onClose ? onClose : () => { },
                pendingModal,
            };
        });
    },

    closeModal: () => {
        set((state) => ({
            active: false,
            modalTitle: '',
            modalBody: React.createElement('div'),
            modalFooter: React.createElement('div'),
            modalStyle: state.modalStyle,
            onClose: () => { },
        }));
    },

    openPendingModalIfExists: () => {
        set((state) => {
            if (!state.pendingModal) return state; // No pending modal to open
            // Open the pending modal
            return {
                active: true,
                modalTitle: state.pendingModal.modalTitle,
                modalBody: state.pendingModal.modalBody,
                modalFooter: state.pendingModal.modalFooter,
                modalStyle: state.pendingModal.modalStyle ?? state.modalStyle,
                onClose: state.pendingModal.onClose ?? (() => { }),
                pendingModal: null, // Clear the pending modal
            };
        });
    },
}));

export default useModalStore;

export const modalStore = useModalStore;