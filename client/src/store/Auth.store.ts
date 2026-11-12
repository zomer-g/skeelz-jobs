import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { UserRole } from '../i18n/General.enums';
import { User, JobApplication } from '../models/interfaces/Props.interfaces';

interface AuthState {
  user: User | null;
  openLogin: boolean;
  userTryToApply: boolean;
  setUser: (user: User) => void;
  setOpenLogin: (shouldOpen: boolean) => void;
  logOut: () => void;
  isUserLoggedIn: () => boolean;
  setUserTryToApply: (userTryToApply: boolean) => void;
  getUserRole: () => UserRole | '';
  updateJobApplication: (jobApplicationId: string) => void; 
}

const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      openLogin: false,
      userTryToApply: false,

      setUser: (user: User) => {
        set({ user });
      },
      
      setOpenLogin: (openLogin: boolean) => {
        set({ openLogin });
      },
      
      logOut: () => {
        set({ user: null });
      },
      
      isUserLoggedIn: () => !!get().user,
      
      setUserTryToApply: (userTryToApply: boolean) => {
        set({ userTryToApply });
      },
      
      getUserRole: () => get().user?.role || "",
      
      // Update only the new jobApplication at the user object
      updateJobApplication: (jobApplicationId: string) => {
        const currentUser = get().user; // Get the current user from Zustand
        if (currentUser) {
            const updatedJobApplications = [...(currentUser.jobApplicationsId|| []), jobApplicationId];
            const updatedUser = { ...currentUser, jobApplicationsId: updatedJobApplications };
            set({ user: updatedUser });
        }
    },
    }),
    {
      name: 'auth-storage',      
    }
  )
);

export default useAuthStore;
