import { create } from "zustand";
import { persist } from "zustand/middleware";

export type UserStore = {
  userSkills: string[];
  s3Url: string;
  initUser: (user: { userSkills?: string[] }) => void;
};

const useUserStore = create<UserStore>()(
  persist(
    (set) => ({
      userSkills: [],
      s3Url: "",

      initUser: ({ userSkills = []}) => {
        set((state) => ({
          userSkills: userSkills.length ? userSkills : state.userSkills,
        }));
      },
    }),
    {
      name: "userStore", // Key for local storage
    }
  )
);

export default useUserStore;
export const userStore = useUserStore;