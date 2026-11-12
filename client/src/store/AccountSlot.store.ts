import { create } from 'zustand';

// The job board shows the login button / user menu in its list-map toolbar row
// (Jobs.tsx), but the login, logout and modal logic lives in Header.tsx. Jobs
// registers the toolbar's account cell here and Header renders the controls into
// it with a portal. Pages without the board (el === null) keep them in the header.
interface AccountSlotState {
  el: HTMLElement | null;
  setEl: (el: HTMLElement | null) => void;
}

const useAccountSlotStore = create<AccountSlotState>()((set) => ({
  el: null,
  setEl: (el) => set({ el }),
}));

export default useAccountSlotStore;
