import { create } from 'zustand';
import { persist, PersistOptions } from 'zustand/middleware';
import { NumericOption, Option } from '../models/interfaces/Props.interfaces';



interface SkillOption {
    label: string;
    value: string;
}

interface ScopeOption {
    label: string;
    value: string;
}

interface HeaderStore {
    selectedLocationOptions: NumericOption[];
    selectedDistrictsOptions: Option[];
    selectedSkillsOptions: SkillOption[];
    selectedScopeOptions: ScopeOption[];
    locationOptions: NumericOption[];
    districtOptions: Option[];
    skillsOptions: SkillOption[];
    scopeOptions: ScopeOption[];
    setSelectedLocationOptions: (options: NumericOption[]) => void;
    setSelectedDistrictsOptions: (options: Option[]) => void;
    setSelectedSkillsOptions: (options: SkillOption[]) => void;
    setSelectedScopeOptions: (options: ScopeOption[]) => void;
    toggleLocationOption: (option: NumericOption) => void;
    toggleSkillOption: (option: SkillOption) => void;
    toggleScopeOption: (option: ScopeOption) => void;
    clearSelectedScopeOptions: () => void;
    clearSelectedSkillsOptions: () => void;
    clearSelectedLocationsOptions: () => void;
    clearSelectedDiscritsOptions: () => void;
    setLocationOptions: (options: NumericOption[]) => void;
    setDistrictsOptions: (options: Option[]) => void;
    setScopeOptions: (options: ScopeOption[]) => void;
    setSkillOptions: (options: SkillOption[]) => void;
}

const useHeaderStore = create<HeaderStore>()(
    persist( 
        (set) => ({
            selectedLocationOptions: [],
            selectedDistrictsOptions: [],
            selectedSkillsOptions: [],
            selectedScopeOptions: [],
            locationOptions: [],
            districtOptions: [],
            skillsOptions: [],
            scopeOptions: [],

            setSelectedLocationOptions: (options) =>
                set({ selectedLocationOptions: options }),

            setSelectedDistrictsOptions: (options: Option[]) =>
                set({ selectedDistrictsOptions: options }),

            setSelectedSkillsOptions: (options) =>
                set({ selectedSkillsOptions: options }),

            setSelectedScopeOptions: (options) =>
                set({ selectedScopeOptions: options }),

            toggleLocationOption: (option) =>
                set((state: { selectedLocationOptions: any[]; }) => {//TODO ANY
                    const isAlreadySelected = state.selectedLocationOptions.some(
                        (selected) => selected.value === option.value
                    );
                    const newSelectedLocationOptions = isAlreadySelected
                        ? state.selectedLocationOptions.filter(
                              (selected) => selected.value !== option.value
                          )
                        : [...state.selectedLocationOptions, option];
                    return { selectedLocationOptions: newSelectedLocationOptions };
                }),

            toggleSkillOption: (option) =>
                set((state: { selectedSkillsOptions: any[]; }) => {
                    const isAlreadySelected = state.selectedSkillsOptions.some(
                        (selected) => selected.value === option.label
                    );
                    const newSelectedSkillsOptions = isAlreadySelected
                        ? state.selectedSkillsOptions.filter(
                              (selected) => selected.value !== option.label
                          )
                        : [...state.selectedSkillsOptions, option];
                    return { selectedSkillsOptions: newSelectedSkillsOptions };
                }),

            toggleScopeOption: (option) =>
                set((state: { selectedScopeOptions: any[]; }) => {
                    const isAlreadySelected = state.selectedScopeOptions.some(
                        (selected) => selected.value === option.value
                    );
                    const newSelectedScopeOptions = isAlreadySelected
                        ? state.selectedScopeOptions.filter(
                              (selected) => selected.value !== option.value
                          )
                        : [...state.selectedScopeOptions, option];
                    return { selectedScopeOptions: newSelectedScopeOptions };
                }),

            clearSelectedScopeOptions: () => set({ selectedScopeOptions: [] }),
            clearSelectedSkillsOptions: () => set({ selectedSkillsOptions: [] }),
            clearSelectedLocationsOptions: () => set({ selectedLocationOptions: [] }),
            clearSelectedDiscritsOptions: () => set({ selectedDistrictsOptions: [] }),

            setLocationOptions: (options) =>
                set({
                    locationOptions: options,
                }),

            setDistrictsOptions: (options: Option[]) =>
                set({
                    districtOptions: options,
                }),

            setScopeOptions: (options) =>
                set({
                    scopeOptions: options,
                }),

            setSkillOptions: (options: SkillOption[]) =>
                set({
                    skillsOptions: options,
                }),
        }),
        {
            name: 'header-store', // Key for localStorage
        }
    )
);

export default useHeaderStore;

export const headerStore = useHeaderStore;
