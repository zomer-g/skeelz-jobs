import { useState, useEffect, useRef } from 'react';
import { Button } from 'react-bootstrap';
import Dropdown from 'react-bootstrap/Dropdown';
import { OptionType } from '../../models/interfaces/General.interfaces';
import { i18n } from '../../i18n/I18n';
import Checkbox from './Checkbox';
import { AngleDownIcon } from '../../icons';

interface DropDownProps {
  title: string;
  options: OptionType[];
  selectedOptions: OptionType[];
  onSelect: (selectedOptions: OptionType[]) => void;
  onSearch: () => void;
  className?: string;
}

function DropDown({ title, options, selectedOptions, onSelect, onSearch, className }: DropDownProps) {
  const [isDropdownOpen, setDropdownOpen] = useState(false);
  const translations = i18n.getTranslations();
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onSelect(selectedOptions);
  }, [selectedOptions, onSelect]);

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

  const handleSelect = (option: OptionType) => {
    const updatedSelectedOptions = selectedOptions.some((selected) => selected.value === option.value)
      ? selectedOptions.filter((selected) => selected.value !== option.value)
      : [...selectedOptions, option];
    onSelect(updatedSelectedOptions);
  };

  const handleClose = () => {
    setDropdownOpen(false);
  };

  return (
    <Dropdown show={isDropdownOpen} onToggle={() => {}}>
      <div ref={dropdownRef}>
        <Dropdown.Toggle
          className={`custom-dropdown-sizes custom-shadow bg-color-white w-100 p-x-0-125rem rounded-pill bg-color-white text-dark d-flex align-items-center justify-content-between ${
            isDropdownOpen ? "border-color-dark-green-2-2px" : "border-color-grey"
          }
            ${className}`
        }
          onClick={() => setDropdownOpen(!isDropdownOpen)}
        >
          <div>
            <span className="font-RubikRegular font-responsive-2 text-truncate ps-1 pe-1 pe-sm-2">{title}</span>
            {selectedOptions.length > 0 && (
              <span className="ms-2 font-RubikRegular font-responsive-2 text-color-dark-green-2">({selectedOptions.length})</span>
            )}
          </div>

          <i className='pb-1'>
            <AngleDownIcon />
          </i>
        </Dropdown.Toggle>

        <Dropdown.Menu className="font-RubikSmall bg-color-white border-radius-8 pb-0 fs-1-1 overflow-auto max-h-400 w-260px custom-dropdown-menu xs-custom-dropdown-menu">
          {options.map((item) => (
            <Dropdown.Item
              as="div"
              className="text-truncate text-end d-flex align-items-center px-3 custom-checkbox"
              key={item.value}
              title={item.label}
              onClick={(e) => e.stopPropagation()} // Prevent closing the dropdown on click
            >
              <Checkbox
                label={item.label}
                checked={selectedOptions.some((selected) => selected.value === item.value)}
                onChange={() => handleSelect(item)}
              />
            </Dropdown.Item>
          ))}
          <div className="bg-light pb-3 shadow-top sticky-bottom">
            <hr />
            <div className="d-flex justify-content-between py-2">
              <Button
                variant="secondary"
                className="bg-color-no-bg text-color-dark-green-2 fw-bold border border-0 w-50"
                onClick={() => {
                  onSelect([]); 
                  handleClose();
                }}
              >
                {translations.DropDown.ClearAll}
              </Button>
              <Button
                variant="secondary"
                className="bg-color-dark-green-2 w-50 ms-2 fs-6 rounded-pill text-center"
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
      </div>
    </Dropdown>
  );
}

export default DropDown;
