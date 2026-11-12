import React, { useEffect, useRef, useState } from 'react';
import Dropdown from 'react-bootstrap/Dropdown';
import Checkbox from './Checkbox';
import { AngleDownIcon } from '../../icons';
import Button from './Button';
import { i18n } from '../../i18n/I18n';
import { GroupedOption, NumericOrStringOption, Option } from '../../models/interfaces/Props.interfaces';

interface CheckBoxAutocompleteProps {
  groupedOptions: GroupedOption[];
  selectedOptions: { [groupId: string]: NumericOrStringOption[] };
  onSelect: (selectedGroupedOptions: GroupedOption[]) => void;
  onSearch: () => void;
  noResultsText?: string;
  changeNamesOptions?: { [key: string]: string };
  className?: string;
}

export default function CheckBoxAutocomplete({
  groupedOptions,
  selectedOptions: parentSelectedOptions,
  onSelect,
  onSearch,
  changeNamesOptions,
  className,
}: CheckBoxAutocompleteProps) {
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedOptions, setSelectedOptions] = useState<{ [groupId: string]: NumericOrStringOption[] }>(
    parentSelectedOptions
  );
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const normalizedSearchTerm = searchTerm.replace(/\s+/g, '[-\\s]*').toLowerCase();
  const translations = i18n.getTranslations();
  // Sync local state with parent-selected options
  useEffect(() => {
    setSelectedOptions(parentSelectedOptions);
  }, [parentSelectedOptions]);

  const handleClose = () => {
    setDropdownOpen(false);
  };

  const handleSearchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

  const handleCheckboxChange = (isChecked: boolean, option: NumericOrStringOption, groupId: string) => {
    setSelectedOptions((prevSelected) => {
      const groupOptions = prevSelected[groupId] || [];
      const updatedGroupOptions = isChecked
        ? [...groupOptions, option]
        : groupOptions.filter((selected) => selected.value !== option.value);

      const updatedSelections = {
        ...prevSelected,
        [groupId]: updatedGroupOptions,
      };

      const groupedSelections = Object.entries(updatedSelections).map(([groupId, options]) => {
        const groupLabel =
          groupedOptions.find((group) => group.groupId === groupId)?.groupLabel || '';
        return { groupId, groupLabel, options };
      });
      onSelect(groupedSelections);

      return updatedSelections;
    });
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Filter grouped options and map names using changeNamesOptions if provided
  const filteredGroupedOptions = groupedOptions.map((group) => ({
    ...group,
    options: group.options
      .map((option) => ({
        ...option,
        label: changeNamesOptions
          ? changeNamesOptions[option.label] || option.label // Map names if changeNamesOptions is provided
          : option.label, // Otherwise, use the original label
      }))
      .filter((option) =>
        new RegExp(normalizedSearchTerm, 'i').test(option.label) // Filter by mapped or original name
      ),
  }));

  return (
    <div ref={dropdownRef}>
      <Dropdown
        show={isDropdownOpen}
        className={`rounded-pill custom-shadow bg-color-white text-dark align-items-center custom-autocomplete-dimensions ${
          isDropdownOpen ? 'border-color-dark-green-2-2px' : 'border-color-grey'
        }
        ${className}`
      }
      >
        <Dropdown.Toggle
          id="dropdown-basic"
          className="custom-autocomplete-dimensions bg-color-no-bg border-color-no-border text-color-black d-flex justify-content-between p-x-0-125rem align-items-center w-100"
          onClick={() => setDropdownOpen(!isDropdownOpen)}
        >
          <span className="font-RubikRegular font-responsive-2 ps-1 text-truncate pe-1 pe-sm-3">
            {translations.DropDown.AreaInCountry}
          </span>
          {Object.values(selectedOptions).flat().length > 0 && (
            <span className="ms-md-2 font-RubikRegular font-responsive-2 text-color-dark-green-2">
              ({Object.values(selectedOptions).flat().length})
            </span>
          )}
          <AngleDownIcon />
        </Dropdown.Toggle>

        <Dropdown.Menu className="font-RubikSmall bg-color-white border-radius-8 fs-1-1 p-0 overflow-auto max-h-400 w-260px custom-dropdown-menu">
          <div className="sticky-top bg-white z-index-3">
            <input
              type="text"
              placeholder={translations.DropDown.Search}
              value={searchTerm}
              onChange={handleSearchChange}
              className="font-RubikSmall form-control py-2"
            />
          </div>

          {filteredGroupedOptions.every((group) => group.options.length === 0) ? (
            <div className="text-center p-2">{translations.DropDown.NoResultsFound}</div>
          ) : (
            filteredGroupedOptions.map((group) => (
              <div key={group.groupId}>
                <div className="py-2 px-3 d-flex border-color-grey-5 bg-color-light-grey height-2-375rem">
                  {group.groupLabel}
                </div>
                {group.options.map((option) => (
                  <div key={option.value} className="d-flex align-items-center px-3">
                    <Checkbox
                      label={option.label}
                      checked={
                        selectedOptions[group.groupId]?.some(
                          (selected) => selected.value === option.value
                        ) || false
                      }
                      onChange={(e) =>
                        handleCheckboxChange(e.target.checked, option, group.groupId)
                      }
                      className="ms-2"
                    />
                  </div>
                ))}
              </div>
            ))
          )}

          <div className="bg-light pb-3 sticky-bottom">
            <hr />
            <div className="d-flex justify-content-between py-2">
              <Button
                className="bg-color-no-bg text-color-dark-green-2 fw-bold border-0 w-50"
                onClick={() => {
                  setSelectedOptions({});
                  onSelect([]); // Notify parent of cleared selections
                  handleClose();
                }}
              >
                {translations.CheckBoxAutoComplete.ClearAll}
              </Button>
              <Button
                className="bg-color-dark-green-2 w-50 py-2 ms-2 fs-6 rounded-pill text-center"
                onClick={() => {
                  onSearch();
                  handleClose();
                }}
              >
                {translations.DropDown.Search}
              </Button>
            </div>
          </div>
        </Dropdown.Menu>
      </Dropdown>
    </div>
  );
}
