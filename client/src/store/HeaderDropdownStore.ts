import { create } from 'zustand';

interface LocationOption {
    label: string;
    value: string;
}

interface OptionType {
    label: string;
    value: string;
}

interface HeaderDropdownStore {
    dropdownStates: Record<string, OptionType[]>;
    setDropdownSelectedOptions: (id: string, options: OptionType[]) => void;
    toggleDropdownOption: (id: string, option: OptionType) => void;
    clearDropdownOptions: (id: string) => void;
}

const useHeaderDropDownStore = create<HeaderDropdownStore>((set) => ({
    dropdownStates: {},

    setDropdownSelectedOptions: (id, options) =>
        set((state) => ({
            dropdownStates: {
                ...state.dropdownStates,
                [id]: options,
            },
        })),

    toggleDropdownOption: (id, option) =>
        set((state) => {
            const currentOptions = state.dropdownStates[id] || [];
            const isAlreadySelected = currentOptions.some(
                (selected) => selected.value === option.value
            );

            const newOptions = isAlreadySelected
                ? currentOptions.filter((selected) => selected.value !== option.value)
                : [...currentOptions, option];

            return {
                dropdownStates: {
                    ...state.dropdownStates,
                    [id]: newOptions,
                },
            };
        }),

    clearDropdownOptions: (id) =>
        set((state) => ({
            dropdownStates: {
                ...state.dropdownStates,
                [id]: [],
            },
        })),
}));

export default useHeaderDropDownStore;

export const headerDropdownStore = useHeaderDropDownStore;
